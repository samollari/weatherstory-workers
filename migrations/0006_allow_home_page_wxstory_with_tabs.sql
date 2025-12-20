-- Migration number: 0006 	 2025-12-20T05:11:51.278Z
ALTER TABLE Offices DROP COLUMN Supported;

ALTER TABLE Offices
    ADD Supported BOOL
    GENERATED ALWAYS AS (PageRelativePath IS NOT NULL AND StoryType = 'tabs') VIRTUAL;