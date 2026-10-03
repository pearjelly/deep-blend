/** Immutable glTF resource snapshots. File URIs are resolved only inside a supplied local root. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, existsSync, openSync, readSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts';
import { streamAsset } from './asset-io.js';
import { fileSha256, removeTree, resolveInside } from './paths.js';
export const BUNDLE_LOCK = '.deepblend-lock.json';
export const BUNDLE_LIMITS = Object.freeze({ files: 256, lockBytes: 1024 * 1024, jsonBytes: 16 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = (message, code = BlenderErrorCode.ASSET_REQUEST_INVALID) => { throw new BlenderError(code, message); };
export function bundlePath(path) {
    if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\\') || /[\0-\x1f]/.test(path)
        || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || /[:<>"|?*]/.test(p)))
        reject('Asset bundle members need contained, portable relative paths.');
    return path;
}
export function gltfResources(document, entrypoint) {
    if (!document || Array.isArray(document) || document.asset?.version !== '2.0')
        reject('The glTF JSON must declare version 2.0.', BlenderErrorCode.ASSET_CONTENT_MISMATCH);
    const paths = new Set();
    for (const key of ['buffers', 'images']) {
        if (document[key] !== undefined && !Array.isArray(document[key]))
            reject(`glTF ${key} must be an array.`);
        for (const item of document[key] ?? []) {
            if (!item || typeof item !== 'object' || Array.isArray(item))
                reject(`Invalid glTF ${key} entry.`);
            const uri = item.uri;
            if (uri === undefined) {
                if (key === 'buffers')
                    reject('JSON glTF buffers require a URI. Use GLB for a binary chunk.');
                continue;
            }
            if (typeof uri !== 'string' || !uri)
                reject('glTF resource URIs must be nonempty strings.');
            if (uri.startsWith('data:')) {
                if (!/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(uri) || uri.split(',')[1].length % 4)
                    reject('glTF embedded resources need valid base64 data URIs.');
                continue;
            }
            if (uri.startsWith('/') || uri.includes('\\') || /[?#]/.test(uri) || /^[a-z][a-z0-9+.-]*:/i.test(uri))
                reject('glTF resources must use relative file URIs or embedded data. No dependency URLs are fetched.');
            let decoded;
            try {
                decoded = decodeURIComponent(uri);
            }
            catch {
                reject('A glTF resource URI has invalid percent encoding.');
            }
            if (decoded.startsWith('/') || decoded.includes('\\') || /[\0-\x1f]/.test(decoded))
                reject('Invalid glTF resource path.');
            const path = bundlePath(posix.normalize(posix.join(posix.dirname(entrypoint), decoded)));
            if (path === BUNDLE_LOCK)
                reject('A glTF resource collides with the reserved bundle lock.');
            paths.add(path);
        }
    }
    // Core buffers/images cover the importer-facing resource graph in this profile.
    // Refuse additional external URI fields in extensions rather than leave them unlocked.
    const queue = [{ value: document, extension: false }];
    for (let index = 0; index < queue.length; index++) {
        if (index > 500000)
            reject('The glTF document exceeds the resource inspection limit.', BlenderErrorCode.ASSET_TOO_LARGE);
        const { value, extension } = queue[index];
        if (!value || typeof value !== 'object')
            continue;
        if (extension && typeof value.uri === 'string' && !/^data:/i.test(value.uri))
            reject('External URI resources inside glTF extensions need a supported dependency profile.');
        for (const [key, child] of Object.entries(value))
            if (child && typeof child === 'object')
                queue.push({ value: child, extension: extension || key === 'extensions' });
    }
    if (paths.size + 1 > BUNDLE_LIMITS.files)
        reject('The glTF bundle exceeds the resource file limit.', BlenderErrorCode.ASSET_TOO_LARGE);
    const folded = new Set();
    for (const path of [entrypoint, ...paths]) {
        const key = path.toLowerCase();
        if (folded.has(key) && path !== entrypoint)
            reject('glTF resource paths collide on case-insensitive filesystems.');
        folded.add(key);
    }
    return [...paths].sort();
}
function readBounded(file, limit) {
    const fd = openSync(file, 'r'), chunks = [];
    let bytes = 0;
    try {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
            const size = readSync(fd, buffer, 0, buffer.length, null);
            if (!size)
                break;
            bytes += size;
            if (bytes > limit)
                reject('Asset bundle metadata exceeds its byte limit.', BlenderErrorCode.ASSET_TOO_LARGE);
            chunks.push(Buffer.from(buffer.subarray(0, size)));
        }
        return Buffer.concat(chunks, bytes);
    }
    finally {
        closeSync(fd);
    }
}
function parseJson(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function readDocument(file) {
    try {
        return parseJson(readBounded(file, BUNDLE_LIMITS.jsonBytes));
    }
    catch (error) {
        if (error instanceof BlenderError)
            throw error;
        reject('The glTF JSON cannot be parsed.', BlenderErrorCode.ASSET_CONTENT_MISMATCH);
    }
}
export function verifyAssetBundle(projectRoot, asset) {
    const match = /^assets\/bundles\/([a-f0-9]{64})\/(.+)$/.exec(asset.path ?? '');
    if (!match)
        return null;
    const root = resolveInside(projectRoot, `assets/bundles/${match[1]}`, 'asset bundle'), lock = resolveInside(root, BUNDLE_LOCK, 'asset bundle lock');
    if (!existsSync(lock))
        reject('The asset bundle lock is missing.', BlenderErrorCode.ASSET_MISSING);
    const bytes = readBounded(lock, BUNDLE_LIMITS.lockBytes);
    if (digest(bytes) !== match[1])
        reject('The asset bundle lock changed.', BlenderErrorCode.ASSET_HASH_MISMATCH);
    let manifest;
    try {
        manifest = parseJson(bytes);
    }
    catch {
        reject('The asset bundle lock cannot be parsed.');
    }
    if (manifest?.schemaVersion !== 'deepblend.asset-bundle/v1' || manifest.entrypoint !== match[2]
        || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > BUNDLE_LIMITS.files)
        reject('The asset bundle lock has an invalid shape or entrypoint.');
    bundlePath(manifest.entrypoint);
    const members = new Map(), folded = new Set();
    let total = 0;
    for (const member of manifest.files) {
        if (!member || typeof member !== 'object' || Array.isArray(member))
            reject('Invalid asset bundle member.');
        const path = bundlePath(member.path);
        if (path === BUNDLE_LOCK || members.has(path) || folded.has(path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(member.sha256 ?? '') || !Number.isSafeInteger(member.bytes) || member.bytes < 0)
            reject('The asset bundle lock contains invalid or duplicate members.');
        const file = resolveInside(root, path, 'asset bundle member');
        if (!existsSync(file))
            reject(`The asset bundle member ${path} is missing.`, BlenderErrorCode.ASSET_MISSING);
        if (!statSync(file).isFile() || statSync(file).size !== member.bytes || fileSha256(file) !== member.sha256)
            reject(`The asset bundle member ${path} changed.`, BlenderErrorCode.ASSET_HASH_MISMATCH);
        members.set(path, member);
        folded.add(path.toLowerCase());
        total += member.bytes;
    }
    if (!Number.isSafeInteger(total) || total !== manifest.totalBytes || !members.has(manifest.entrypoint)
        || (asset.sha256 && asset.sha256 !== members.get(manifest.entrypoint).sha256))
        reject('The asset bundle identity does not agree with its declaration.', BlenderErrorCode.ASSET_HASH_MISMATCH);
    for (const path of gltfResources(readDocument(resolveInside(root, manifest.entrypoint, 'glTF entrypoint')), manifest.entrypoint))
        if (!members.has(path))
            reject(`The glTF resource ${path} is not locked.`);
    return manifest;
}
export async function prepareGltfBundle({ projectRoot, sourcePath, name, sourceRoot, local, maxBytes, signal }) {
    if (sourceRoot !== undefined && (!local || typeof sourceRoot !== 'string' || !sourceRoot))
        reject('sourceRoot requires a local glTF source directory.');
    const sourceBase = resolve(sourceRoot ?? dirname(sourcePath)), entrypoint = bundlePath(local ? relative(sourceBase, resolve(sourcePath)).split(sep).join('/') : name);
    resolveInside(sourceBase, sourcePath, 'glTF source');
    const parent = resolveInside(projectRoot, 'assets/bundles', 'asset bundle directory');
    mkdirSync(parent, { recursive: true });
    const staging = join(parent, `.incoming-${randomUUID()}`);
    mkdirSync(staging);
    try {
        const files = [];
        let totalBytes = 0;
        const copy = async (path, sourceOverride) => {
            signal?.throwIfAborted();
            const source = resolveInside(sourceBase, sourceOverride ?? path, 'glTF resource'), target = resolveInside(staging, path, 'staged glTF resource');
            if (!existsSync(source) || !statSync(source).isFile())
                reject(`The local glTF resource ${path} is missing.`, BlenderErrorCode.ASSET_SOURCE_NOT_FOUND);
            mkdirSync(dirname(target), { recursive: true });
            const result = await streamAsset(createReadStream(source), target, { maxBytes: maxBytes - totalBytes, signal, label: path });
            totalBytes += result.bytes;
            files.push({ path, ...result });
        };
        await copy(entrypoint, local ? undefined : sourcePath);
        const resources = gltfResources(readDocument(join(staging, entrypoint)), entrypoint);
        if (!local && resources.length)
            reject('Remote glTF dependencies are not fetched. Import a local resource directory or a self-contained file.');
        for (const path of resources)
            if (path !== entrypoint)
                await copy(path);
        files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const manifest = { schemaVersion: 'deepblend.asset-bundle/v1', entrypoint, files, totalBytes }, lockBytes = Buffer.from(JSON.stringify(manifest) + '\n');
        if (totalBytes + lockBytes.length > maxBytes)
            reject('The glTF bundle and lock exceed assetMaxBytes.', BlenderErrorCode.ASSET_TOO_LARGE);
        if (lockBytes.length > BUNDLE_LIMITS.lockBytes)
            reject('The asset bundle lock exceeds its byte limit.', BlenderErrorCode.ASSET_TOO_LARGE);
        writeFileSync(join(staging, BUNDLE_LOCK), lockBytes, { flag: 'wx' });
        const bundleSha256 = digest(lockBytes), relativePath = `assets/bundles/${bundleSha256}/${entrypoint}`, main = files.find(file => file.path === entrypoint);
        return { staging, relativePath, sourceRoot: local ? sourceBase : null, bytes: main.bytes, sha256: main.sha256, bundle: { sha256: bundleSha256, ...manifest }, publish() {
                const destination = resolveInside(projectRoot, `assets/bundles/${bundleSha256}`, 'asset bundle destination');
                try {
                    renameSync(staging, destination);
                }
                catch (error) {
                    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code))
                        throw error;
                    verifyAssetBundle(projectRoot, { path: relativePath, sha256: main.sha256 });
                }
                return destination;
            } };
    }
    catch (error) {
        removeTree(staging);
        throw error;
    }
}
