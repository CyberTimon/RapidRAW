import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

# Translations for the new Exposure (formerly EV Shift) and Brightness (formerly Exposure) keys
TRANSLATIONS = {
    "ca": {
        "adjustments": {
            "basic": {
                "exposure": "Exposició",
                "brightness": "Brillantor"
            }
        }
    },
    "de": {
        "adjustments": {
            "basic": {
                "exposure": "Belichtung",
                "brightness": "Helligkeit"
            }
        }
    },
    "en": {
        "adjustments": {
            "basic": {
                "exposure": "Exposure",
                "brightness": "Brightness"
            }
        }
    },
    "es": {
        "adjustments": {
            "basic": {
                "exposure": "Exposición",
                "brightness": "Brillo"
            }
        }
    },
    "fr": {
        "adjustments": {
            "basic": {
                "exposure": "Exposition",
                "brightness": "Luminosité"
            }
        }
    },
    "it": {
        "adjustments": {
            "basic": {
                "exposure": "Esposizione",
                "brightness": "Luminosità"
            }
        }
    },
    "ja": {
        "adjustments": {
            "basic": {
                "exposure": "露出",
                "brightness": "明るさ"
            }
        }
    },
    "ko": {
        "adjustments": {
            "basic": {
                "exposure": "노출",
                "brightness": "밝기"
            }
        }
    },
    "pl": {
        "adjustments": {
            "basic": {
                "exposure": "Ekspozycja",
                "brightness": "Jasność"
            }
        }
    },
    "pt": {
        "adjustments": {
            "basic": {
                "exposure": "Exposição",
                "brightness": "Brilho"
            }
        }
    },
    "ru": {
        "adjustments": {
            "basic": {
                "exposure": "Экспозиция",
                "brightness": "Яркость"
            }
        }
    },
    "zh-CN": {
        "adjustments": {
            "basic": {
                "exposure": "曝光",
                "brightness": "亮度"
            }
        }
    },
    "zh-TW": {
        "adjustments": {
            "basic": {
                "exposure": "曝光",
                "brightness": "亮度"
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

    # Remove the deprecated evShift key if it exists
    try:
        if "evShift" in data.get("adjustments", {}).get("basic", {}):
            del data["adjustments"]["basic"]["evShift"]
    except Exception:
        pass

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

    print("Starting translation updates for Exposure and Brightness keys...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
