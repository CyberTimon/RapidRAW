import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "library": {
            "thumbnailFit": {
                "justified": "Mosaic"
            }
        }
    },
    "de": {
        "library": {
            "thumbnailFit": {
                "justified": "Mosaik"
            }
        }
    },
    "en": {
        "library": {
            "thumbnailFit": {
                "justified": "Masonry"
            }
        }
    },
    "es": {
        "library": {
            "thumbnailFit": {
                "justified": "Mosaico"
            }
        }
    },
    "fr": {
        "library": {
            "thumbnailFit": {
                "justified": "Mosaïque"
            }
        }
    },
    "it": {
        "library": {
            "thumbnailFit": {
                "justified": "Mosaico"
            }
        }
    },
    "ja": {
        "library": {
            "thumbnailFit": {
                "justified": "メイソンリー"
            }
        }
    },
    "ko": {
        "library": {
            "thumbnailFit": {
                "justified": "메이슨리"
            }
        }
    },
    "pl": {
        "library": {
            "thumbnailFit": {
                "justified": "Mozaika"
            }
        }
    },
    "pt": {
        "library": {
            "thumbnailFit": {
                "justified": "Mosaico"
            }
        }
    },
    "ru": {
        "library": {
            "thumbnailFit": {
                "justified": "Мозаика"
            }
        }
    },
    "zh-CN": {
        "library": {
            "thumbnailFit": {
                "justified": "瀑布流"
            }
        }
    },
    "zh-TW": {
        "library": {
            "thumbnailFit": {
                "justified": "瀑布流"
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

    # 1. Merge new translations
    deep_merge(data, trans)

    # 2. Sort alphabetically to maintain formatting consistency
    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting translation updates for Masonry/Justified thumbnail fit...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
