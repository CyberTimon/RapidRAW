import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Llenç gris neutre",
                "neutralGreyCanvasDesc": "Utilitzeu un llenç gris neutre per a una gradació de color i exposició més precisa sense canviar el tema de l'aplicació.",
                "enableNeutralGreyCanvas": "Activa el fons gris neutre"
            }
        }
    },
    "de": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Neutralgraue Arbeitsfläche",
                "neutralGreyCanvasDesc": "Verwenden Sie eine neutralgraue Arbeitsfläche für eine genauere Farb- und Belichtungskorrektur, ohne das App-Design zu ändern.",
                "enableNeutralGreyCanvas": "Neutralgrauen Hintergrund aktivieren"
            }
        }
    },
    "en": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Neutral Grey Canvas",
                "neutralGreyCanvasDesc": "Use a neutral grey canvas for more accurate color and exposure grading without changing the app theme.",
                "enableNeutralGreyCanvas": "Enable Neutral Grey Background"
            }
        }
    },
    "es": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Lienzo gris neutro",
                "neutralGreyCanvasDesc": "Utiliza un lienzo gris neutro para una gradación de color y exposición más precisa sin cambiar el tema de la aplicación.",
                "enableNeutralGreyCanvas": "Activar fondo gris neutro"
            }
        }
    },
    "fr": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Toile gris neutre",
                "neutralGreyCanvasDesc": "Utilisez une toile gris neutre pour un étalonnage des couleurs et de l'exposition plus précis sans modifier le thème de l'application.",
                "enableNeutralGreyCanvas": "Activer le fond gris neutre"
            }
        }
    },
    "it": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Tela grigio neutro",
                "neutralGreyCanvasDesc": "Usa una tela grigio neutro per una correzione del colore e dell'esposizione più precisa senza cambiare il tema dell'app.",
                "enableNeutralGreyCanvas": "Abilita sfondo grigio neutro"
            }
        }
    },
    "ja": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "ニュートラルグレーのキャンバス",
                "neutralGreyCanvasDesc": "アプリのテーマを変更せずに、より正確な色と露出のグレーディングを行うために、ニュートラルグレーのキャンバスを使用します。",
                "enableNeutralGreyCanvas": "ニュートラルグレーの背景を有効にする"
            }
        }
    },
    "ko": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "뉴트럴 그레이 캔버스",
                "neutralGreyCanvasDesc": "앱 테마를 변경하지 않고 더 정확한 색상 및 노출 보정을 위해 뉴트럴 그레이 캔버스를 사용합니다.",
                "enableNeutralGreyCanvas": "뉴트럴 그레이 배경 활성화"
            }
        }
    },
    "pl": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Neutralne szare płótno",
                "neutralGreyCanvasDesc": "Użyj neutralnego, szarego płótna do dokładniejszej korekcji kolorów i ekspozycji bez zmiany motywu aplikacji.",
                "enableNeutralGreyCanvas": "Włącz neutralne szare tło"
            }
        }
    },
    "pt": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Tela cinza neutro",
                "neutralGreyCanvasDesc": "Use uma tela cinza neutro para uma gradação de cores e exposição mais precisa sem alterar o tema do aplicativo.",
                "enableNeutralGreyCanvas": "Ativar fundo cinza neutro"
            }
        }
    },
    "ru": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "Нейтрально-серый холст",
                "neutralGreyCanvasDesc": "Используйте нейтрально-серый холст для более точной цветокоррекции и настройки экспозиции без изменения темы приложения.",
                "enableNeutralGreyCanvas": "Включить нейтрально-серый фон"
            }
        }
    },
    "zh-CN": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "中性灰画布",
                "neutralGreyCanvasDesc": "使用中性灰画布，以便在不更改应用主题的情况下进行更准确的色彩和曝光分级。",
                "enableNeutralGreyCanvas": "启用中性灰背景"
            }
        }
    },
    "zh-TW": {
        "settings": {
            "general": {
                "neutralGreyCanvas": "中性灰畫布",
                "neutralGreyCanvasDesc": "使用中性灰畫布，以便在不更改應用程式主題的情況下進行更準確的色彩和曝光分級。",
                "enableNeutralGreyCanvas": "啟用中性灰背景"
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

    print("Starting translation updates for Neutral Grey Canvas settings...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
