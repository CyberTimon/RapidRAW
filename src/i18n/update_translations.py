import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "de": {
        "copyPaste": {
            "autoSyncTitle": "Anpassungen automatisch synchronisieren",
            "autoSyncLabel": "Auto-Sync aktivieren",
            "autoSyncDesc": "Wendet Anpassungen automatisch auf alle ausgewählten Bilder an."
        }
    },
    "en": {
        "copyPaste": {
            "autoSyncTitle": "Auto-sync adjustments",
            "autoSyncLabel": "Enable auto-sync",
            "autoSyncDesc": "Automatically apply adjustments to all selected images."
        }
    },
    "es": {
        "copyPaste": {
            "autoSyncTitle": "Sincronizar ajustes automáticamente",
            "autoSyncLabel": "Habilitar sincronización automática",
            "autoSyncDesc": "Aplica automáticamente los ajustes a todas las imágenes seleccionadas."
        }
    },
    "fr": {
        "copyPaste": {
            "autoSyncTitle": "Synchronisation automatique des réglages",
            "autoSyncLabel": "Activer la synchronisation automatique",
            "autoSyncDesc": "Applique automatiquement les réglages à toutes les images sélectionnées."
        }
    },
    "it": {
        "copyPaste": {
            "autoSyncTitle": "Sincronizzazione automatica regolazioni",
            "autoSyncLabel": "Abilita sincronizzazione automatica",
            "autoSyncDesc": "Applica automaticamente le regolazioni a tutte le immagini selezionate."
        }
    },
    "ja": {
        "copyPaste": {
            "autoSyncTitle": "調整の自動同期",
            "autoSyncLabel": "自動同期を有効にする",
            "autoSyncDesc": "選択したすべての画像に調整を自動的に適用します。"
        }
    },
    "ko": {
        "copyPaste": {
            "autoSyncTitle": "조정 자동 동기화",
            "autoSyncLabel": "자동 동기화 활성화",
            "autoSyncDesc": "선택한 모든 이미지에 조정을 자동으로 적용합니다."
        }
    },
    "pl": {
        "copyPaste": {
            "autoSyncTitle": "Automatyczna synchronizacja dostosowań",
            "autoSyncLabel": "Włącz auto-synchronizację",
            "autoSyncDesc": "Automatycznie stosuje dostosowania do wszystkich wybranych obrazów."
        }
    },
    "pt": {
        "copyPaste": {
            "autoSyncTitle": "Sincronização automática de ajustes",
            "autoSyncLabel": "Ativar sincronização automática",
            "autoSyncDesc": "Aplica automaticamente os ajustes a todas as imagens selecionadas."
        }
    },
    "ru": {
        "copyPaste": {
            "autoSyncTitle": "Автосинхронизация коррекций",
            "autoSyncLabel": "Включить автосинхронизацию",
            "autoSyncDesc": "Автоматически применяет коррекции ко всем выбранным изображениям."
        }
    },
    "zh-CN": {
        "copyPaste": {
            "autoSyncTitle": "自动同步调整",
            "autoSyncLabel": "启用自动同步",
            "autoSyncDesc": "自动将调整应用于所有选定的图像。"
        }
    },
    "zh-TW": {
        "copyPaste": {
            "autoSyncTitle": "自動同步調整",
            "autoSyncLabel": "啟用自動同步",
            "autoSyncDesc": "自動將調整套用於所有選取的影像。"
        }
    }
}

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

    # Navigate to or create modals -> copyPaste node
    modals_node = data.setdefault("modals", {})
    copy_paste_node = modals_node.setdefault("copyPaste", {})

    for key, value in trans["copyPaste"].items():
        copy_paste_node[key] = value

    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting sorted translation updates...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
