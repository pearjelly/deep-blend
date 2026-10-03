"""Verify managed glTF bundles before any scene mutation; no bpy dependency."""
import hashlib,json,os,posixpath,re,struct
from urllib.parse import unquote
from deepblend_util import ActionError
from deepblend_obj_resources import obj_libraries,mtl_images
LOCK='.deepblend-lock.json'
MAX_FILES=256
MAX_LOCK=1024*1024
MAX_JSON=16*1024*1024
MAX_CHUNKS=1024

def fail(message,code='ASSET_REQUEST_INVALID'):
    raise ActionError(code,message)

def member_path(path):
    if not isinstance(path,str) or not path or len(path)>1024 or '\\' in path or path.startswith('/') or re.search(r'[\x00-\x1f]',path) or any(not p or p in ('.','..') or re.search(r'[:<>"|?*]',p) for p in path.split('/')):
        fail('Asset bundle members need contained, portable relative paths.')
    return path

def inside(root,path):
    base=os.path.realpath(root);target=os.path.realpath(os.path.join(base,path))
    if target!=base and not target.startswith(base+os.sep):
        fail('An asset bundle path escapes its directory.','PATH_OUTSIDE_WORKSPACE')
    return target

def read_bytes(path,limit):
    try:
        if os.path.getsize(path)>limit:
            fail('The asset bundle metadata exceeds its byte limit.','ASSET_TOO_LARGE')
        with open(path,'rb') as source:
            data=source.read(limit+1)
        if len(data)>limit:
            fail('The asset bundle metadata exceeds its byte limit.','ASSET_TOO_LARGE')
        return data
    except OSError:
        fail('An asset bundle file is missing.','ASSET_MISSING')

def read_json(path,limit):
    data=read_bytes(path,limit)
    try:return data,json.loads(data)
    except (ValueError,UnicodeError):fail('The asset bundle metadata cannot be parsed.','ASSET_CONTENT_MISMATCH')

def parse_document(data):
    try:return json.loads(data.decode('utf-8-sig'),parse_constant=lambda value:fail('Non-finite glTF JSON value.','ASSET_CONTENT_MISMATCH'))
    except (ValueError,UnicodeError):fail('The glTF metadata cannot be parsed.','ASSET_CONTENT_MISMATCH')

def read_document(path,format='gltf'):
    if format=='gltf':return parse_document(read_bytes(path,MAX_JSON)),None
    if format!='glb':fail('Unsupported asset bundle format.')
    try:
        with open(path,'rb') as source:
            size=os.fstat(source.fileno()).st_size
            def read(offset,length):
                source.seek(offset);data=source.read(length)
                if len(data)!=length:fail('The GLB is truncated.','ASSET_CONTENT_MISMATCH')
                return data
            if size<20:fail('The GLB header is truncated.','ASSET_CONTENT_MISMATCH')
            magic,version,declared=struct.unpack('<4sII',read(0,12))
            if magic!=b'glTF' or version!=2 or declared!=size:fail('The GLB must be a complete version 2 container.','ASSET_CONTENT_MISMATCH')
            offset=12;document=None;bin_bytes=None;chunks=0;json_seen=False
            while offset<size:
                chunks+=1
                if chunks>MAX_CHUNKS:fail('The GLB exceeds the chunk inspection limit.','ASSET_TOO_LARGE')
                if offset+8>size:fail('The GLB chunk header is truncated.','ASSET_CONTENT_MISMATCH')
                length,kind=struct.unpack('<II',read(offset,8))
                if length%4 or offset+8+length>size:fail('The GLB chunk length is invalid.','ASSET_CONTENT_MISMATCH')
                if chunks==1 and kind!=0x4e4f534a:fail('The first GLB chunk must contain JSON.','ASSET_CONTENT_MISMATCH')
                if kind==0x4e4f534a:
                    if json_seen:fail('The GLB contains duplicate JSON chunks.','ASSET_CONTENT_MISMATCH')
                    if length>MAX_JSON:fail('The GLB JSON exceeds 16 MiB.','ASSET_TOO_LARGE')
                    json_seen=True;document=parse_document(read(offset+8,length))
                elif kind==0x004e4942:
                    if chunks!=2 or bin_bytes is not None:fail('The GLB BIN must be its second chunk.','ASSET_CONTENT_MISMATCH')
                    bin_bytes=length
                offset+=8+length
            if not isinstance(document,dict) or not isinstance(document.get('asset'),dict) or document['asset'].get('version')!='2.0':fail('The GLB JSON must declare glTF 2.0.','ASSET_CONTENT_MISMATCH')
            return document,bin_bytes
    except OSError:fail('A glTF asset file is missing.','ASSET_MISSING')

def resources(document,entrypoint,bin_bytes=None):
    if not isinstance(document,dict) or not isinstance(document.get('asset'),dict) or document['asset'].get('version')!='2.0':
        fail('The glTF JSON must declare version 2.0.','ASSET_CONTENT_MISMATCH')
    paths=set()
    for key in ('buffers','images'):
        entries=document.get(key,[])
        if not isinstance(entries,list):fail('glTF resources must be arrays.')
        for index,item in enumerate(entries):
            if not isinstance(item,dict):fail('Invalid glTF resource entry.')
            uri=item.get('uri')
            if uri is None and 'uri' not in item:
                if key=='buffers' and (index!=0 or bin_bytes is None or type(item.get('byteLength')) is not int or not 0<=item['byteLength']<=bin_bytes or bin_bytes-item['byteLength']>3):fail('An embedded buffer requires the first GLB buffer and a matching BIN chunk.')
                continue
            if not isinstance(uri,str) or not uri:fail('glTF resource URIs must be nonempty strings.')
            if uri.startswith('data:'):
                if not re.fullmatch(r'data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}',uri) or len(uri.split(',')[1])%4:fail('glTF embedded resources need valid base64 data URIs.')
                continue
            if uri.startswith('/') or '\\' in uri or '?' in uri or '#' in uri or re.match(r'^[a-z][a-z0-9+.-]*:',uri,re.I):fail('glTF resources must use relative file URIs or embedded data.')
            if re.search(r'%(?![a-f0-9]{2})',uri,re.I):fail('A glTF resource URI has invalid percent encoding.')
            try:decoded=unquote(uri,errors='strict')
            except UnicodeError:fail('A glTF resource URI has invalid percent encoding.')
            if decoded.startswith('/') or '\\' in decoded or re.search(r'[\x00-\x1f]',decoded):fail('Invalid glTF resource path.')
            path=member_path(posixpath.normpath(posixpath.join(posixpath.dirname(entrypoint),decoded)))
            if path==LOCK:fail('A glTF resource collides with the reserved bundle lock.')
            paths.add(path)
    queue=[(document,False)];index=0
    while index<len(queue):
        if index>500000:fail('The glTF resource graph exceeds its inspection limit.','ASSET_TOO_LARGE')
        value,extension=queue[index];index+=1
        if isinstance(value,dict):
            if extension and isinstance(value.get('uri'),str) and not value['uri'].lower().startswith('data:'):fail('External URI resources inside glTF extensions need a supported dependency profile.')
            queue.extend((child,extension or key=='extensions') for key,child in value.items() if isinstance(child,(dict,list)))
        elif isinstance(value,list):queue.extend((child,extension) for child in value if isinstance(child,(dict,list)))
    if len(paths)+1>MAX_FILES:fail('The glTF bundle exceeds its file limit.','ASSET_TOO_LARGE')
    folded=set()
    for path in [entrypoint]+list(paths):
        key=path.lower()
        if key in folded and path!=entrypoint:fail('glTF resource paths collide on case-insensitive filesystems.')
        folded.add(key)
    return paths

def verify_asset_bundle(project_root,asset):
    match=re.fullmatch(r'assets/bundles/([a-f0-9]{64})/(.+)',asset.get('path',''))
    if not match:return None
    root=inside(project_root,'assets/bundles/'+match.group(1));data=read_bytes(inside(root,LOCK),MAX_LOCK)
    if hashlib.sha256(data).hexdigest()!=match.group(1):fail('The asset bundle lock changed.','ASSET_HASH_MISMATCH')
    try:manifest=json.loads(data)
    except (ValueError,UnicodeError):fail('The asset bundle lock cannot be parsed.','ASSET_CONTENT_MISMATCH')
    if not isinstance(manifest,dict) or manifest.get('schemaVersion')!='deepblend.asset-bundle/v1' or manifest.get('entrypoint')!=match.group(2) or not isinstance(manifest.get('files'),list) or not 1<=len(manifest['files'])<=MAX_FILES:
        fail('The asset bundle lock has an invalid shape or entrypoint.')
    member_path(manifest['entrypoint']);format=manifest.get('format','gltf')
    if format not in ('gltf','glb','obj') or (asset.get('type') and asset['type']!=format):fail('The asset bundle format does not match its declaration.')
    members={};folded=set();total=0
    for member in manifest['files']:
        if not isinstance(member,dict):fail('Invalid asset bundle member.')
        path=member_path(member.get('path'));size=member.get('bytes');sha=member.get('sha256')
        if path==LOCK or path in members or path.lower() in folded or not isinstance(sha,str) or not re.fullmatch(r'[a-f0-9]{64}',sha) or type(size) is not int or not 0<=size<=9007199254740991:
            fail('The asset bundle lock contains invalid or duplicate members.')
        file=inside(root,path);digest=hashlib.sha256();actual_size=0
        try:
            with open(file,'rb') as source:
                for chunk in iter(lambda:source.read(64*1024),b''):
                    actual_size+=len(chunk)
                    if actual_size>size:fail('An asset bundle member changed size.','ASSET_HASH_MISMATCH')
                    digest.update(chunk)
        except OSError:fail('An asset bundle member is missing.','ASSET_MISSING')
        if actual_size!=size or digest.hexdigest()!=sha:fail('An asset bundle member changed.','ASSET_HASH_MISMATCH')
        members[path]=member;folded.add(path.lower());total+=size
    main=members.get(manifest['entrypoint'])
    if total>9007199254740991 or type(manifest.get('totalBytes')) is not int or manifest['totalBytes']!=total or main is None or (asset.get('sha256') and asset['sha256']!=main['sha256']):
        fail('The asset bundle identity does not agree with its declaration.','ASSET_HASH_MISMATCH')
    if format=='obj':paths=obj_resources(root,manifest['entrypoint'])
    else:
        document,bin_bytes=read_document(inside(root,manifest['entrypoint']),format)
        paths=resources(document,manifest['entrypoint'],bin_bytes)
    for path in paths:
        if path not in members:fail('A glTF resource is not locked.')
    return manifest

def verify_unbundled_gltf_asset(project_root,asset):
    if asset.get('type') not in ('gltf','glb') or re.match(r'assets/bundles/[a-f0-9]{64}/',asset.get('path','')):return
    document,bin_bytes=read_document(inside(project_root,asset.get('path','')),asset['type'])
    if resources(document,posixpath.basename(asset.get('path','')),bin_bytes):fail('This glTF/GLB has unlocked external resources. Reimport the local source with a containing sourceRoot.')


def obj_reference(entrypoint,name):
    if not name or name.startswith('/') or '\\' in name or re.match(r'^[a-z][a-z0-9+.-]*:',name,re.I):
        fail('OBJ resources require portable relative file paths. No dependency URLs are fetched.')
    path=member_path(posixpath.normpath(posixpath.join(posixpath.dirname(entrypoint),name)))
    if path==LOCK:fail('An OBJ resource collides with the reserved bundle lock.')
    return path

def obj_resources(root,entrypoint):
    libraries={obj_reference(entrypoint,name) for name in obj_libraries(inside(root,entrypoint))}
    fallback=posixpath.splitext(entrypoint)[0]+'.mtl'
    if os.path.exists(inside(root,fallback)):libraries.add(fallback)
    paths=set(libraries);folded={entrypoint.lower():entrypoint}
    def check(path):
        previous=folded.get(path.lower())
        if previous is not None and previous!=path:fail('OBJ resource paths collide on case-insensitive filesystems.')
        folded[path.lower()]=path
        if len(paths|{entrypoint})>MAX_FILES:fail('The OBJ bundle exceeds its resource file limit.','ASSET_TOO_LARGE')
    for library in libraries:
        check(library)
        for name in mtl_images(inside(root,library)):
            path=obj_reference(library,name);paths.add(path);check(path)
    for path in paths:check(path)
    return paths

def verify_unbundled_obj_asset(project_root,asset):
    if asset.get('type')!='obj' or re.match(r'assets/bundles/[a-f0-9]{64}/',asset.get('path','')):return
    file=inside(project_root,asset.get('path',''));fallback=posixpath.splitext(asset.get('path',''))[0]+'.mtl'
    if obj_libraries(file) or os.path.exists(inside(project_root,fallback)):
        fail('This OBJ has unlocked material resources. Reimport the complete local source with a containing sourceRoot.')
