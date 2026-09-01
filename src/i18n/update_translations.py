import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "editor": {
            "crop": {
                "labels": {"guided": "Guiat"},
                "tooltips": {"guided": "Correcció de perspectiva guiada"},
            },
            "guided": {
                "constrainCrop": "Restringir el retall",
                "hint": "Dibuixa al llarg de les vores que han de ser verticals o horitzontals",
                "lineCount": "{{count}}/4 línies dibuixades, en calen almenys 2",
                "toast": {
                    "aggressiveCrop": "La correcció retalla una gran part de la imatge",
                    "angleRejected": "La línia s'allunya massa de la vertical o l'horitzontal",
                    "maxLines": "Màxim 2 línies verticals i 2 horitzontals",
                    "needTwoLines": "Dibuixa almenys 2 línies per a la correcció de perspectiva",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Perspectiva guiada"}},
            "guidedPerspective": {
                "apply": "Aplicar",
                "cancel": "Cancel·lar",
                "resetTooltip": "Restablir les línies guia",
                "title": "Perspectiva guiada",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Commuta la perspectiva guiada"}}
        },
    },
    "de": {
        "editor": {
            "crop": {
                "labels": {"guided": "Führung"},
                "tooltips": {"guided": "Geführte Perspektivkorrektur"},
            },
            "guided": {
                "constrainCrop": "Zuschnitt begrenzen",
                "hint": "Zeichne entlang von Kanten, die senkrecht oder waagerecht sein sollen",
                "lineCount": "{{count}}/4 Linien gezeichnet, mindestens 2 nötig",
                "toast": {
                    "aggressiveCrop": "Die Korrektur schneidet einen großen Teil des Bildes ab",
                    "angleRejected": "Linie weicht zu stark von Senkrecht oder Waagerecht ab",
                    "maxLines": "Maximal 2 senkrechte und 2 waagerechte Linien",
                    "needTwoLines": "Zeichne mindestens 2 Linien für die Perspektivkorrektur",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Geführte Perspektive"}},
            "guidedPerspective": {
                "apply": "Übernehmen",
                "cancel": "Abbrechen",
                "resetTooltip": "Hilfslinien zurücksetzen",
                "title": "Geführte Perspektive",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Geführte Perspektive umschalten"}}
        },
    },
    "en": {
        "editor": {
            "crop": {
                "labels": {"guided": "Guided"},
                "tooltips": {"guided": "Guided perspective correction"},
            },
            "guided": {
                "constrainCrop": "Constrain Crop",
                "hint": "Draw along edges that should be vertical or horizontal",
                "lineCount": "{{count}}/4 lines drawn, need at least 2",
                "toast": {
                    "aggressiveCrop": "Correction crops away a large part of the image",
                    "angleRejected": "Line is too far from vertical or horizontal",
                    "maxLines": "Maximum 2 vertical and 2 horizontal lines",
                    "needTwoLines": "Draw at least 2 lines for perspective correction",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Guided Perspective"}},
            "guidedPerspective": {
                "apply": "Apply",
                "cancel": "Cancel",
                "resetTooltip": "Reset guide lines",
                "title": "Guided Perspective",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Toggle guided perspective"}}
        },
    },
    "es": {
        "editor": {
            "crop": {
                "labels": {"guided": "Guiado"},
                "tooltips": {"guided": "Corrección de perspectiva guiada"},
            },
            "guided": {
                "constrainCrop": "Restringir recorte",
                "hint": "Dibuja a lo largo de los bordes que deben ser verticales u horizontales",
                "lineCount": "{{count}}/4 líneas dibujadas, se necesitan al menos 2",
                "toast": {
                    "aggressiveCrop": "La corrección recorta una gran parte de la imagen",
                    "angleRejected": "La línea se aleja demasiado de la vertical o la horizontal",
                    "maxLines": "Máximo 2 líneas verticales y 2 horizontales",
                    "needTwoLines": "Dibuja al menos 2 líneas para la corrección de perspectiva",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Perspectiva guiada"}},
            "guidedPerspective": {
                "apply": "Aplicar",
                "cancel": "Cancelar",
                "resetTooltip": "Restablecer líneas guía",
                "title": "Perspectiva guiada",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Alternar perspectiva guiada"}}
        },
    },
    "fr": {
        "editor": {
            "crop": {
                "labels": {"guided": "Guidé"},
                "tooltips": {"guided": "Correction de perspective guidée"},
            },
            "guided": {
                "constrainCrop": "Contraindre le recadrage",
                "hint": "Tracez le long des bords qui doivent être verticaux ou horizontaux",
                "lineCount": "{{count}}/4 lignes tracées, 2 minimum",
                "toast": {
                    "aggressiveCrop": "La correction recadre une grande partie de l'image",
                    "angleRejected": "La ligne s'écarte trop de la verticale ou de l'horizontale",
                    "maxLines": "Maximum 2 lignes verticales et 2 horizontales",
                    "needTwoLines": "Tracez au moins 2 lignes pour la correction de perspective",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Perspective guidée"}},
            "guidedPerspective": {
                "apply": "Appliquer",
                "cancel": "Annuler",
                "resetTooltip": "Réinitialiser les lignes de guide",
                "title": "Perspective guidée",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Basculer la perspective guidée"}}
        },
    },
    "it": {
        "editor": {
            "crop": {
                "labels": {"guided": "Guidato"},
                "tooltips": {"guided": "Correzione prospettica guidata"},
            },
            "guided": {
                "constrainCrop": "Vincola ritaglio",
                "hint": "Disegna lungo i bordi che devono essere verticali o orizzontali",
                "lineCount": "{{count}}/4 linee disegnate, ne servono almeno 2",
                "toast": {
                    "aggressiveCrop": "La correzione ritaglia una gran parte dell'immagine",
                    "angleRejected": "La linea è troppo lontana dalla verticale o dall'orizzontale",
                    "maxLines": "Massimo 2 linee verticali e 2 orizzontali",
                    "needTwoLines": "Disegna almeno 2 linee per la correzione prospettica",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Prospettiva guidata"}},
            "guidedPerspective": {
                "apply": "Applica",
                "cancel": "Annulla",
                "resetTooltip": "Reimposta le linee guida",
                "title": "Prospettiva guidata",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Attiva/disattiva prospettiva guidata"}}
        },
    },
    "ja": {
        "editor": {
            "crop": {
                "labels": {"guided": "ガイド"},
                "tooltips": {"guided": "ガイド付き遠近補正"},
            },
            "guided": {
                "constrainCrop": "クロップを制限",
                "hint": "垂直または水平にすべきエッジに沿って描画します",
                "lineCount": "{{count}}/4 本の線（最低2本必要）",
                "toast": {
                    "aggressiveCrop": "補正により画像の大部分が切り取られます",
                    "angleRejected": "線が垂直または水平から離れすぎています",
                    "maxLines": "垂直・水平それぞれ最大2本まで",
                    "needTwoLines": "遠近補正には少なくとも2本の線が必要です",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "ガイド遠近法"}},
            "guidedPerspective": {
                "apply": "適用",
                "cancel": "キャンセル",
                "resetTooltip": "ガイド線をリセット",
                "title": "ガイド遠近法",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "ガイド遠近法を切り替え"}}
        },
    },
    "ko": {
        "editor": {
            "crop": {
                "labels": {"guided": "가이드"},
                "tooltips": {"guided": "가이드 원근 보정"},
            },
            "guided": {
                "constrainCrop": "크롭 제한",
                "hint": "수직 또는 수평이어야 하는 가장자리를 따라 그리세요",
                "lineCount": "{{count}}/4개 선, 최소 2개 필요",
                "toast": {
                    "aggressiveCrop": "보정으로 이미지의 많은 부분이 잘립니다",
                    "angleRejected": "선이 수직 또는 수평에서 너무 벗어났습니다",
                    "maxLines": "수직·수평 선은 각각 최대 2개",
                    "needTwoLines": "원근 보정을 위해 선을 2개 이상 그리세요",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "가이드 원근"}},
            "guidedPerspective": {
                "apply": "적용",
                "cancel": "취소",
                "resetTooltip": "가이드 선 초기화",
                "title": "가이드 원근",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "가이드 원근 전환"}}
        },
    },
    "pl": {
        "editor": {
            "crop": {
                "labels": {"guided": "Prowadzone"},
                "tooltips": {"guided": "Prowadzona korekcja perspektywy"},
            },
            "guided": {
                "constrainCrop": "Ogranicz kadrowanie",
                "hint": "Rysuj wzdłuż krawędzi, które mają być pionowe lub poziome",
                "lineCount": "{{count}}/4 linie, potrzeba co najmniej 2",
                "toast": {
                    "aggressiveCrop": "Korekcja obcina dużą część obrazu",
                    "angleRejected": "Linia zbyt mocno odbiega od pionu lub poziomu",
                    "maxLines": "Maksimum 2 linie pionowe i 2 poziome",
                    "needTwoLines": "Narysuj co najmniej 2 linie do korekcji perspektywy",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Prowadzona perspektywa"}},
            "guidedPerspective": {
                "apply": "Zastosuj",
                "cancel": "Anuluj",
                "resetTooltip": "Resetuj linie prowadzące",
                "title": "Prowadzona perspektywa",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Przełącz prowadzoną perspektywę"}}
        },
    },
    "pt": {
        "editor": {
            "crop": {
                "labels": {"guided": "Guiado"},
                "tooltips": {"guided": "Correção de perspetiva guiada"},
            },
            "guided": {
                "constrainCrop": "Restringir recorte",
                "hint": "Desenhe ao longo das arestas que devem ser verticais ou horizontais",
                "lineCount": "{{count}}/4 linhas desenhadas, são necessárias pelo menos 2",
                "toast": {
                    "aggressiveCrop": "A correção recorta uma grande parte da imagem",
                    "angleRejected": "A linha está demasiado longe da vertical ou da horizontal",
                    "maxLines": "Máximo de 2 linhas verticais e 2 horizontais",
                    "needTwoLines": "Desenhe pelo menos 2 linhas para a correção de perspetiva",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Perspetiva guiada"}},
            "guidedPerspective": {
                "apply": "Aplicar",
                "cancel": "Cancelar",
                "resetTooltip": "Repor linhas-guia",
                "title": "Perspetiva guiada",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Alternar perspetiva guiada"}}
        },
    },
    "ru": {
        "editor": {
            "crop": {
                "labels": {"guided": "Направл."},
                "tooltips": {"guided": "Управляемая коррекция перспективы"},
            },
            "guided": {
                "constrainCrop": "Ограничить кадрирование",
                "hint": "Проведите вдоль рёбер, которые должны быть вертикальными или горизонтальными",
                "lineCount": "{{count}}/4 линии, нужно минимум 2",
                "toast": {
                    "aggressiveCrop": "Коррекция обрезает большую часть изображения",
                    "angleRejected": "Линия слишком далеко от вертикали или горизонтали",
                    "maxLines": "Максимум 2 вертикальные и 2 горизонтальные линии",
                    "needTwoLines": "Нарисуйте минимум 2 линии для коррекции перспективы",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "Управляемая перспектива"}},
            "guidedPerspective": {
                "apply": "Применить",
                "cancel": "Отмена",
                "resetTooltip": "Сбросить направляющие",
                "title": "Управляемая перспектива",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "Переключить управляемую перспективу"}}
        },
    },
    "zh-CN": {
        "editor": {
            "crop": {
                "labels": {"guided": "引导"},
                "tooltips": {"guided": "引导式透视校正"},
            },
            "guided": {
                "constrainCrop": "约束裁剪",
                "hint": "沿应保持垂直或水平的边缘绘制",
                "lineCount": "已绘制 {{count}}/4 条线，至少需要 2 条",
                "toast": {
                    "aggressiveCrop": "校正会裁掉图像的很大一部分",
                    "angleRejected": "线条偏离垂直或水平太多",
                    "maxLines": "最多 2 条垂直线和 2 条水平线",
                    "needTwoLines": "透视校正至少需要绘制 2 条线",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "引导透视"}},
            "guidedPerspective": {
                "apply": "应用",
                "cancel": "取消",
                "resetTooltip": "重置辅助线",
                "title": "引导透视",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "切换引导透视"}}
        },
    },
    "zh-TW": {
        "editor": {
            "crop": {
                "labels": {"guided": "引導"},
                "tooltips": {"guided": "引導式透視校正"},
            },
            "guided": {
                "constrainCrop": "約束裁切",
                "hint": "沿著應保持垂直或水平的邊緣繪製",
                "lineCount": "已繪製 {{count}}/4 條線，至少需要 2 條",
                "toast": {
                    "aggressiveCrop": "校正會裁掉影像的很大一部分",
                    "angleRejected": "線條偏離垂直或水平太多",
                    "maxLines": "最多 2 條垂直線和 2 條水平線",
                    "needTwoLines": "透視校正至少需要繪製 2 條線",
                },
            },
        },
        "modals": {
            "copyPaste": {"groups": {"guidedPerspective": "引導透視"}},
            "guidedPerspective": {
                "apply": "套用",
                "cancel": "取消",
                "resetTooltip": "重設輔助線",
                "title": "引導透視",
            },
        },
        "settings": {
            "keybinds": {"actions": {"toggle_guided_perspective": "切換引導透視"}}
        },
    },
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

    # 2. Clean up removed keys from the diff
    if "editor" in data and "masks" in data["editor"]:
        data["editor"]["masks"].pop("createNewTitle", None)
        if "tooltips" in data["editor"]["masks"]:
            data["editor"]["masks"]["tooltips"].pop("showMore", None)

    # 3. Sort alphabetically
    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")


def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting translation updates for guided perspective...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")


if __name__ == "__main__":
    main()
