/** Maintained public local-provider connector; no independent adoption claim. */
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local';
import { join } from 'node:path';
export async function createRuntime({ workspaceRoot, scenario, signal }) {
    signal.throwIfAborted();
    const ctx = new Context();
    try {
        ctx.plugin(LocalSubprocess);
        ctx.plugin(Provider, ProviderConfig({ workspaceRoot,
            blenderPath: scenario === 'unavailable' ? join(workspaceRoot, 'missing-blender') : process.env.DEEPBLEND_BLENDER_PATH ?? 'auto',
            timeoutMs: 90000 }));
        for (let i = 0; i < 100; i++) {
            signal.throwIfAborted();
            const runtime = ctx.get('blenderRuntime');
            if (runtime)
                return { runtime, close: () => ctx.fiber.dispose() };
            await new Promise(done => setTimeout(done, 20));
        }
        throw Error('Local provider did not activate');
    }
    catch (error) {
        try {
            await ctx.fiber.dispose();
        }
        catch (cleanup) {
            error.cleanupFailure = cleanup.message;
        }
        throw error;
    }
}
