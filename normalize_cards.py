import json

with open('cards_raw.json', 'r', encoding='utf-8') as f:
    cards = json.load(f)

BASE = "https://cdn.bottcg.com/cards"
special_rares = ["SCR", "PR", "CBR"]
special_sets = set(["B2SA", "B2SB"])
subdirs = {
    "SD09": "123v1k1",
    "RM01": "0aslabe",
    "BT12": "thankyoupnes",
    "B2SA": "thankyoupnes",
    "B2SB": "thankyoupnes",
    "CC03": "234b2o"
}

def get_official_card_image_url(print_id, rare):
    p = print_id.split("-")[0]
    folder = subdirs.get(p)
    base_path = f"{BASE}/{folder.strip('/')}" if folder else BASE
    m = f"{print_id}-{rare}" if (rare and (rare in special_rares or p in special_sets)) else print_id
    return f"{base_path}/{m}.png"

normalized = []
for c in cards:
    print_id = c.get('print', '').strip()
    rare = c.get('rare', '').strip() if c.get('rare') else 'C'
    effect = c.get('mainEffect', '') or ''
    hashtag = c.get('hashtagText', '') or ''
    ex_field = str(c.get('ex', '') or '')
    
    is_only_one = (
        ex_field == 'Only #1' or
        'Only #1' in effect or
        'Only #1' in hashtag or
        c.get('customLimit') == 1
    )
    is_bias = ex_field == 'ลำเอียง' or 'ลำเอียง' in effect or 'ลำเอียง' in hashtag
    is_collab = ex_field == 'โดนใจ' or 'โดนใจ' in effect or 'โดนใจ' in hashtag

    img_url = get_official_card_image_url(print_id, rare)

    norm_card = {
        'printId': print_id,
        'name': c.get('name', '').strip(),
        'type': c.get('type', '').strip(),
        'subtype': c.get('subtype', '').strip() if c.get('subtype') else None,
        'soi': c.get('soi', 1),
        'cost': c.get('cost', 0) if c.get('cost') is not None else 0,
        'gem': c.get('gem', 0) if c.get('gem') is not None else 0,
        'gemColor': c.get('gemColor') or c.get('color'),
        'power': c.get('power', 0) if c.get('power') is not None else 0,
        'symbol': c.get('symbol', '').strip() if c.get('symbol') else None,
        'color': c.get('color', '').strip() if c.get('color') else 'ไร้สี',
        'rarity': rare,
        'dropRate': c.get('dropRate', ''),
        'mainEffect': effect,
        'favorText': c.get('favorText', ''),
        'creator': c.get('creator', ''),
        'isOnlyOne': is_only_one,
        'isBias': is_bias,
        'isCollab': is_collab,
        'imageUrl': img_url
    }
    normalized.append(norm_card)

with open('cards_clean.json', 'w', encoding='utf-8') as f:
    json.dump(normalized, f, ensure_ascii=False, indent=2)

with open('src/engine/sampleCards.json', 'w', encoding='utf-8') as f:
    json.dump(normalized[:80], f, ensure_ascii=False, indent=2)

print(f'Successfully updated 2014 cards with official image URLs.')
