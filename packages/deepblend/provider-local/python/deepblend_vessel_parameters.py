"""Handled-cup inputs, validated before creating Blender data blocks."""
import math
from deepblend_util import ActionError


def handled_cup_parameters(spec):
    def invalid(message):
        raise ActionError('SCENE_SPEC_INVALID', 'handled_cup: '+message)
    fields=['radius','height','wallThickness','baseThickness','footRound','handleRadius','handleLower','handleUpper',
            'rootRadius','rootLength','rootTension','segments','sectionSegments','handleSegments','rootSegments','wallRows']
    for key in fields:
        if key in spec and (isinstance(spec[key],bool) or not isinstance(spec[key],(int,float))
                or not math.isfinite(spec[key]) or spec[key]<=0):
            invalid(key+' must be a finite positive number')
    radius = spec.get('radius', .04)
    height = spec.get('height', radius*2.625)
    wall = spec.get('wallThickness', radius*.075)
    bottom = spec.get('baseThickness', radius*.125)
    values = {
        'radius': radius, 'height': height, 'wall': wall, 'bottom': bottom,
        'footRound': spec.get('footRound', min(wall, bottom*.8)),
        'handleRadius': spec.get('handleRadius', radius*.1375),
        'lower': spec.get('handleLower', height*(4/15)),
        'upper': spec.get('handleUpper', height*(26/35)),
        'rootRadius': spec.get('rootRadius', radius*.2625),
        'rootLength': spec.get('rootLength', radius*.2),
        'rootTension': spec.get('rootTension', 1),
        'bodySegments': spec.get('segments', 192),
        'sectionSegments': spec.get('sectionSegments', 96),
        'handleSegments': spec.get('handleSegments', 96),
        'rootSegments': spec.get('rootSegments', 32),
        'wallRows': spec.get('wallRows', 40),
    }
    if any(isinstance(v, bool) or not isinstance(v, (int,float)) or not math.isfinite(v) or v<=0 for v in values.values()):
        invalid('dimensions and resolutions must be finite positive numbers')
    def within(v,lo,hi): return lo-1e-12<=v<=hi+1e-12
    if not 1 <= values['rootTension'] <= 1.5:
        invalid('rootTension must be within 1–1.5')
    ratios=[('radius',radius,.02,.08),('height/radius',height/radius,1.8,4),
        ('wallThickness/radius',wall/radius,.025,.15),('baseThickness/radius',bottom/radius,.05,.25),
        ('handleRadius/radius',values['handleRadius']/radius,.05,.2),
        ('rootRadius/radius',values['rootRadius']/radius,.12,.35),
        ('rootRadius/handleRadius',values['rootRadius']/values['handleRadius'],1.4,3),
        ('rootLength/rootRadius',values['rootLength']/values['rootRadius'],.4,1.2),
        ('footRound/radius',values['footRound']/radius,.01,.15)]
    for name,value,lo,hi in ratios:
        if not within(value,lo,hi):invalid('%s must be within %s–%s' % (name,lo,hi))
    gap=(values['upper']-values['lower'])/2
    if gap<=0 or values['rootLength']/gap>.8+1e-12:
        invalid('handleUpper must exceed handleLower; rootLength/half-gap must be <=0.8')
    if gap+radius*1e-12<max(1.1*values['rootRadius'],2*values['handleRadius']):
        invalid('attachment half-gap must be >=1.1*rootRadius and >=2*handleRadius')
    if values['lower']-values['rootRadius']+radius*1e-12<values['footRound']+.01*radius:
        invalid('lower root footprint must clear the rounded foot by 0.01*radius')
    if values['upper']+values['rootRadius']>height-wall/2-.01*radius+radius*1e-12:
        invalid('upper root footprint must clear the rounded lip by 0.01*radius')
    for key,lo,hi,multiple in [('bodySegments',64,256,4),('sectionSegments',32,96,4),
        ('handleSegments',24,128,4),('rootSegments',8,48,1),('wallRows',16,64,1)]:
        value=values[key]
        if value!=int(value) or not lo<=value<=hi or value%multiple:
            invalid('%s must be an integer within %s–%s, divisible by %s' % (key,lo,hi,multiple))
        values[key] = int(value)
    if values['footRound']>min(wall,bottom*.8)+radius*1e-12:
        invalid('footRound must not exceed wallThickness or 0.8*baseThickness')
    return values
