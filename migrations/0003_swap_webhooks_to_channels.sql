-- Migration number: 0003 	 2025-07-13T21:45:30.071Z

-- !!!!!! Destructive: Deletes all existing subscriptions
DELETE FROM Subscriptions;

ALTER TABLE Subscriptions
DROP WebhookURL;

-- Allow guild ID to be null for DM channels
ALTER TABLE Subscriptions
ADD GuildId TEXT;

ALTER TABLE Subscriptions
ADD ChannelId TEXT NOT NULL;

CREATE UNIQUE INDEX unique_subscription on Subscriptions(ChannelId, OfficeId);

