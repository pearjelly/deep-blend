#!/usr/bin/env node
import { formatEnvironmentReport, inspectEnvironment } from './doctor.js'
import { runFunctionalProbe } from './functional-probe.js'

const help = `deepblend-doctor [--json] [--require-video] [--probe]
  [--blender PATH] [--dsh PATH] [--pnpm PATH] [--ffmpeg PATH] [--ffprobe PATH]

Read-only environment checks / 只读环境自检
Reports all missing tools, supported versions and next steps.
FFmpeg/ffprobe are optional unless --require-video is selected.
Explicit paths check the executables you name; profile configuration is not read.
--probe renders a small temporary Blender image and checks MP4 encoding/decoding.
It does not verify the plugin, the configured model, image input or visual review.
Exit: 0 required tools ready, 1 requirements missing, 2 invalid arguments.
This does not install tools or change your DSH profile.`

function main(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0 }
  const commands = {}
  let json = false
  let requireVideo = false
  let functional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') json = true
    else if (arg === '--require-video') requireVideo = true
    else if (arg === '--probe') functional = true
    else if (/^--(?:blender|dsh|pnpm|ffmpeg|ffprobe)$/.test(arg)) {
      const path = args[++i]
      if (!path || path.startsWith('--')) { console.error(`${arg} requires an executable path.\n${help}`); return 2 }
      commands[arg.slice(2)] = path
    } else { console.error(`Unknown argument: ${arg}\n${help}`); return 2 }
  }
  const report = inspectEnvironment({ commands })
  if (functional) {
    report.functional = runFunctionalProbe({ commands })
    report.scope = 'Executable versions and a small temporary Workbench PNG and MP4 round trip only; this does not verify the DSH profile, plugin activation, model, image input, visual review or product quality.'
  }
  console.log(json ? JSON.stringify(report, null, 2) : formatEnvironmentReport(report))
  const exercised = !functional || (report.functional.blenderPreview.status === 'pass' && (!requireVideo || report.functional.videoEncoding.status === 'pass'))
  return report.ready.installation && (!requireVideo || report.ready.video) && exercised ? 0 : 1
}

process.exitCode = main(process.argv.slice(2))
