-- One row per image record: the original (copy_id = '') or one of its virtual copies.
-- `data` holds the same JSON a .rrdata sidecar would; rating, flag and tags are copied
-- out of it so the library can be queried without parsing every record.
CREATE TABLE image_metadata (
    source_path TEXT NOT NULL,
    copy_id     TEXT NOT NULL DEFAULT '',
    folder      TEXT NOT NULL,
    data        TEXT NOT NULL,
    rating      INTEGER NOT NULL DEFAULT 0,
    flag        TEXT,
    tags        TEXT,
    modified_ms INTEGER NOT NULL,
    PRIMARY KEY (source_path, copy_id)
) WITHOUT ROWID;

CREATE INDEX image_metadata_folder ON image_metadata (folder);

-- Records that could not be parsed are moved here instead of being dropped.
CREATE TABLE quarantined_metadata (
    source_path    TEXT NOT NULL,
    copy_id        TEXT NOT NULL,
    data           TEXT NOT NULL,
    reason         TEXT NOT NULL,
    quarantined_ms INTEGER NOT NULL
);
