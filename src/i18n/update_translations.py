import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Commutar l'anàlisi al panell d'ajustos"
            }
        }
    },
    "de": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Analyseanzeige im Anpassungen-Panel umschalten"
            }
        }
    },
    "en": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Toggle analytics in Adjustments panel"
            }
        }
    },
    "es": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Alternar análisis en el panel de Ajustes"
            }
        }
    },
    "fr": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Afficher/Masquer l'analyse dans le panneau Réglages"
            }
        }
    },
    "it": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Mostra/Nascondi analisi nel pannello Regolazioni"
            }
        }
    },
    "ja": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "調整パネルでアナリティクスを切り替える"
            }
        }
    },
    "ko": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "조정 패널에서 분석 토글"
            }
        }
    },
    "pl": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Przełącz analizę w panelu Dopasowania"
            }
        }
    },
    "pt": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Alternar análise no painel de Ajustes"
            }
        }
    },
    "ru": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "Переключить аналитику на панели «Коррекция»"
            }
        }
    },
    "zh-CN": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "在调整面板中切换分析"
            }
        }
    },
    "zh-TW": {
        "editor": {
            "masks": {
                "toggleAnalyticsInAdjustments": "在調整面板中切換分析"
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

    print("Starting Analytics translation updates...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
