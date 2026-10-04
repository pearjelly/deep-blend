"""Bounded OBJ/MTL reference inspection; independent of Node and bpy."""
import os,re
from deepblend_util import ActionError
MAX_OBJ=1024*1024*1024
MAX_MTL=16*1024*1024
MAX_LINE=1024*1024
MAP_KEYS={'map_Kd','map_Ks','map_Ns','map_d','refl','map_refl','map_Ke','bump','map_Bump','map_bump','map_Pr','map_Pm','map_Ps'}
COUNTS={'-bm':1,'-type':1,'-blendu':1,'-blendv':1,'-boost':1,'-cc':1,'-clamp':1,'-imfchan':1,'-mm':2,'-t':3,'-texres':1}

def fail(message,code='ASSET_REQUEST_INVALID'):raise ActionError(code,message)
def numeric(value):
    if not re.fullmatch(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?',value,re.I):return False
    import math
    return math.isfinite(float(value))

def lines(path,limit,continuation=False):
    try:
        if os.path.getsize(path)>limit:fail('OBJ/MTL text exceeds its byte limit.','ASSET_TOO_LARGE')
        total=0;logical='';first=True
        with open(path,'rb') as source:
            while True:
                raw=source.readline(MAX_LINE+2)
                if not raw:
                    if logical:yield logical
                    break
                total+=len(raw)
                if total>limit:fail('OBJ/MTL text exceeds its byte limit.','ASSET_TOO_LARGE')
                physical=raw.rstrip(b'\n')
                if len(physical)>MAX_LINE:fail('OBJ/MTL lines exceed 1 MiB.','ASSET_TOO_LARGE')
                line=physical.decode('utf-8-sig' if first else 'utf-8');first=False
                continued=continuation and re.search(r'\\[\t\r ]*$',line)
                logical+=re.sub(r'\\[\t\r ]*$',' ',line) if continued else line
                if len(logical.encode('utf-8'))>MAX_LINE:fail('OBJ/MTL logical lines exceed 1 MiB.','ASSET_TOO_LARGE')
                if not continued:yield logical;logical=''
    except UnicodeError:fail('OBJ/MTL text must be valid UTF-8.','ASSET_CONTENT_MISMATCH')
    except OSError:fail('An OBJ/MTL file is missing.','ASSET_MISSING')

def obj_declarations(path):
    for line in lines(path,MAX_OBJ,True):
        field=line.split(None,1)
        if not field or field[0] not in ('mtllib','usemtl'):continue
        name=field[1].strip() if len(field)>1 else ''
        if field[0]=='mtllib':
            if len(name)>2 and name.startswith('"') and name.endswith('"'):name=name[1:-1]
            if not name:fail('An OBJ material library reference is empty.')
        yield field[0],name

def obj_libraries(path):
    return {name for kind,name in obj_declarations(path) if kind=='mtllib'}

def mtl_image_records(path):
    material=None
    for line in lines(path,MAX_MTL):
        field=line.split(None,1)
        if not field:continue
        if field[0]=='newmtl':material=field[1].strip() if len(field)>1 else '';continue
        if material is None or field[0] not in MAP_KEYS:continue
        rest=field[1].strip() if len(field)>1 else ''
        while rest:
            token=rest.split(None,1)[0]
            if token in ('-o','-s'):
                rest=rest[len(token):].lstrip()
                for i in range(3):
                    value=rest.split(None,1)[0] if rest else ''
                    if not numeric(value):break
                    rest=rest[len(value):].lstrip()
            elif token in COUNTS:
                rest=rest[len(token):].lstrip()
                for i in range(COUNTS[token]):
                    value=rest.split(None,1)[0] if rest else ''
                    if not value or (token=='-bm' and not numeric(value)):fail('An MTL texture option is incomplete or invalid.')
                    rest=rest[len(value):].lstrip()
            else:break
        name=rest.strip().replace('"','')
        if not name:fail('An MTL texture reference is empty.')
        yield material,field[0],name

def mtl_images(path):
    return {name for material,kind,name in mtl_image_records(path)}
