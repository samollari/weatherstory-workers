-- Migration number: 0005 	 2025-12-20T02:51:40.127Z
ALTER TABLE Offices
    ADD Supported BOOL
    GENERATED ALWAYS AS (PageRelativePath = '/weatherstory' AND StoryType = 'tabs') VIRTUAL;