-- Migration number: 0001 	 2025-07-06T03:36:46.715Z

DROP TABLE Subscriptions;
DROP TABLE Offices;

-- Create tables
CREATE TABLE IF NOT EXISTS Offices (
    OfficeId INTEGER PRIMARY KEY,
    CallSign VARCHAR(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS Subscriptions (
    id INTEGER PRIMARY KEY,
    OfficeId INTEGER NOT NULL,
    WebhookURL TEXT NOT NULL,

    FOREIGN KEY(OfficeId) REFERENCES Offices(OfficeId)
);

-- Populate regional offices

INSERT INTO Offices (CallSign)
VALUES
    ('AFC'),
    ('AFG'),
    ('AJK'),
    ('BOU'),
    ('GJT'),
    ('PUB'),
    ('LOT'),
    ('ILX'),
    ('IND'),
    ('IWX'),
    ('DVN'),
    ('DMX'),
    ('DDC'),
    ('GLD'),
    ('TOP'),
    ('ICT'),
    ('JKL'),
    ('LMK'),
    ('PAH'),
    ('DTX'),
    ('APX'),
    ('GRR'),
    ('MQT'),
    ('DLH'),
    ('MPX'),
    ('EAX'),
    ('SGF'),
    ('LSX'),
    ('GID'),
    ('LBF'),
    ('OAX'),
    ('BIS'),
    ('FGF'),
    ('ABR'),
    ('UNR'),
    ('FSD'),
    ('GRB'),
    ('ARX'),
    ('MKX'),
    ('CYS'),
    ('RIW'),
    ('CAR'),
    ('GYX'),
    ('BOX'),
    ('PHI'),
    ('ALY'),
    ('BGM'),
    ('BUF'),
    ('OKX'),
    ('MHX'),
    ('RAH'),
    ('ILM'),
    ('CLE'),
    ('ILN'),
    ('PBZ'),
    ('CTP'),
    ('CHS'),
    ('CAE'),
    ('GSP'),
    ('BTV'),
    ('LWX'),
    ('RNK'),
    ('AKQ'),
    ('RLX'),
    ('GUM'),
    ('HFO'),
    ('PPG'),
    ('BMX'),
    ('HUN'),
    ('MOB'),
    ('LZK'),
    ('JAX'),
    ('KEY'),
    ('MLB'),
    ('MFL'),
    ('TAE'),
    ('TBW'),
    ('FFC'),
    ('LCH'),
    ('LIX'),
    ('SHV'),
    ('JAN'),
    ('ABQ'),
    ('OUN'),
    ('TSA'),
    ('SJU'),
    ('MEG'),
    ('MRX'),
    ('OHX'),
    ('AMA'),
    ('EWX'),
    ('BRO'),
    ('CRP'),
    ('FWD'),
    ('EPZ'),
    ('HGX'),
    ('LUB'),
    ('MAF'),
    ('SJT'),
    ('FGZ'),
    ('PSR'),
    ('TWC'),
    ('EKA'),
    ('LOX'),
    ('STO'),
    ('SGX'),
    ('MTR'),
    ('HNX'),
    ('BOI'),
    ('PIH'),
    ('BYZ'),
    ('GGW'),
    ('TFX'),
    ('MSO'),
    ('LKN'),
    ('VEF'),
    ('REV'),
    ('MFR'),
    ('PDT'),
    ('PQR'),
    ('SLC'),
    ('SEW'),
    ('OTX');