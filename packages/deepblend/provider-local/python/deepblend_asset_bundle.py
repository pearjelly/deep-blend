"""Verify managed glTF bundles before any scene mutation; no bpy dependency."""
import hashlib,json,os,posixpath,re
from urllib.parse import unquote
from deepblend_util import ActionError
LOCK='.deepblend-lock.json'
MAX_FILES=256
MAX_LOCK=1024*1024
MAX_JSON=16*1024*1024

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

def resources(document,entrypoint):
    if not isinstance(document,dict) or not isinstance(document.get('asset'),dict) or document['asset'].get('version')!='2.0':
        fail('The glTF JSON must declare version 2.0.','ASSET_CONTENT_MISMATCH')
    paths=set()
    for key in ('buffers','images'):
        entries=document.get(key,[])
        if not isinstance(entries,list):fail('glTF resources must be arrays.')
        for item in entries:
            if not isinstance(item,dict):fail('Invalid glTF resource entry.')
            uri=item.get('uri')
            if uri is None and 'uri' not in item:
                if key=='buffers':fail('JSON glTF buffers require a URI.')
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
    member_path(manifest['entrypoint']);members={};folded=set();total=0
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
    _,document=read_json(inside(root,manifest['entrypoint']),MAX_JSON)
    for path in resources(document,manifest['entrypoint']):
        if path not in members:fail('A glTF resource is not locked.')
    return manifest
