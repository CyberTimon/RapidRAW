import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "de": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "RAW immer decodieren",
                "alwaysDecodeRawDesc": "Erzwingt die vollständige RAW-Decodierung für Vorschaubilder, anstatt eingebettete JPEG-Vorschauen zu verwenden. Aktiviere diese Option, wenn sich die Vorschaubilder farblich oder im Kontrast vom geöffneten Bild unterscheiden.",
                "alwaysDecodeRawLabel": "RAW für Vorschaubilder immer decodieren"
            }
        }
    },
    "en": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Always Decode RAW",
                "alwaysDecodeRawDesc": "Force full RAW decoding for thumbnails instead of using embedded JPEG previews. Enable this if your thumbnails look different in color or contrast compared to the opened image.",
                "alwaysDecodeRawLabel": "Always decode RAW for thumbnails"
            }
        }
    },
    "es": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Decodificar RAW siempre",
                "alwaysDecodeRawDesc": "Fuerza la decodificación RAW completa para las miniaturas en lugar de usar vistas previas JPEG incrustadas. Activa esta opción si las miniaturas tienen colores o contrastes diferentes a la imagen abierta.",
                "alwaysDecodeRawLabel": "Decodificar RAW siempre para miniaturas"
            }
        }
    },
    "fr": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Toujours décoder le RAW",
                "alwaysDecodeRawDesc": "Force le décodage RAW complet pour les miniatures au lieu d'utiliser les aperçus JPEG intégrés. Activez cette option si vos miniatures ont des couleurs ou des contrastes différents de l'image ouverte.",
                "alwaysDecodeRawLabel": "Toujours décoder le RAW pour les miniatures"
            }
        }
    },
    "it": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Decodifica RAW sempre",
                "alwaysDecodeRawDesc": "Forza la decodifica RAW completa per le miniature invece di usare le anteprime JPEG incorporate. Attiva questa opzione se i colori o il contrasto delle miniature sono diversi dall'immagine aperta.",
                "alwaysDecodeRawLabel": "Decodifica RAW sempre per le miniature"
            }
        }
    },
    "ja": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "常にRAWをデコード",
                "alwaysDecodeRawDesc": "埋め込まれたJPEGプレビューを使用する代わりに、サムネイルの完全なRAWデコードを強制します。サムネイルの色やコントラストが開いた画像と異なる場合に有効にしてください。",
                "alwaysDecodeRawLabel": "サムネイル用に常にRAWをデコード"
            }
        }
    },
    "ko": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "항상 RAW 디코딩",
                "alwaysDecodeRawDesc": "포함된 JPEG 미리보기를 사용하는 대신 썸네일에 대해 전체 RAW 디코딩을 강제합니다. 썸네일의 색상이나 대비가 열린 이미지와 다르게 보이는 경우 이 옵션을 활성화하세요.",
                "alwaysDecodeRawLabel": "썸네일에 대해 항상 RAW 디코딩"
            }
        }
    },
    "pl": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Zawsze dekoduj RAW",
                "alwaysDecodeRawDesc": "Wymusza pełne dekodowanie RAW dla miniatur zamiast korzystania z osadzonych podglądów JPEG. Włącz tę opcję, jeśli miniatury różnią się kolorami lub kontrastem od otwartego obrazu.",
                "alwaysDecodeRawLabel": "Zawsze dekoduj RAW dla miniatur"
            }
        }
    },
    "pt": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Sempre decodificar RAW",
                "alwaysDecodeRawDesc": "Força a decodificação RAW completa para miniaturas em vez de usar visualizações JPEG incorporadas. Ative esta opção se as suas miniaturas tiverem cores ou contrastes diferentes em comparação com a imagem aberta.",
                "alwaysDecodeRawLabel": "Sempre decodificar RAW para miniaturas"
            }
        }
    },
    "ru": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "Всегда декодировать RAW",
                "alwaysDecodeRawDesc": "Принудительно использовать полное декодирование RAW для миниатюр вместо встроенных превью JPEG. Включите эту опцию, если цвета или контрастность миниатюр отличаются от открытого изображения.",
                "alwaysDecodeRawLabel": "Всегда декодировать RAW для миниатюр"
            }
        }
    },
    "zh-CN": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "始终解码 RAW",
                "alwaysDecodeRawDesc": "强制对缩略图进行完整的 RAW 解码，而不是使用内置的 JPEG 预览。如果您的缩略图在颜色或对比度上与打开的图像不同，请启用此选项。",
                "alwaysDecodeRawLabel": "始终为缩略图解码 RAW"
            }
        }
    },
    "zh-TW": {
        "settings": {
            "processing": {
                "alwaysDecodeRaw": "始終解碼 RAW",
                "alwaysDecodeRawDesc": "強制對縮圖進行完整的 RAW 解碼，而不是使用內建的 JPEG 預覽。如果您的縮圖在顏色或對比度上與打開的影像不同，請啟用此選項。",
                "alwaysDecodeRawLabel": "始終為縮圖解碼 RAW"
            }
        }
    }
}

def deep_merge(target: dict, source: dict):
    """Recursively merges source dict into target dict."""
    for key, value in source.items():
        if isinstance(value, dict):
            node = target.setdefault(key, {})
            if isinstance(node, dict):
                deep_merge(node, value)
        else:
            target[key] = value

def sort_dict_recursively(item):
    if isinstance(item, dict):
        return {k: sort_dict_recursively(v) for k, v in sorted(item.items())}
    elif isinstance(item, list):
        return [sort_dict_recursively(x) for x in item]
    return item

def update_json_file(file_path: Path, trans: dict):
    if not file_path.exists():
        print(f"Skipping: {file_path.name} (File not found)")
        return

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        print(f"Error parsing JSON in {file_path.name}. Skipping.")
        return

    deep_merge(data, trans)
    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting thumbnail RAW decoding translation updates...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
