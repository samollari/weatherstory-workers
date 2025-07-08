-- Migration number: 0002 	 2025-07-08T17:16:56.386Z

ALTER TABLE Subscriptions
ADD dev BOOLEAN
        NOT NULL
        CHECK (dev IN (0, 1))
        DEFAULT 0;