-- BATTLE OF TALINGCHAN ONLINE DATABASE SCHEMA (SUPABASE POSTGRESQL)

-- 1. CARDS MASTER TABLE
CREATE TABLE cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    print_id VARCHAR(50) NOT NULL, -- e.g. SD01-001, BT12-004
    name VARCHAR(255) NOT NULL,
    card_type VARCHAR(50) NOT NULL, -- Avatar, Magic, Construct, Life, Token
    subtype VARCHAR(50), -- Normal, Modification, React, Land for Magic
    soi INT DEFAULT 1,
    cost INT DEFAULT 0,
    gem INT DEFAULT 0,
    gem_color VARCHAR(50),
    power INT,
    symbol VARCHAR(100),
    color VARCHAR(50),
    rarity VARCHAR(20),
    drop_rate VARCHAR(100),
    main_effect TEXT,
    hashtag_text TEXT,
    favor_text TEXT,
    creator VARCHAR(100),
    image_url TEXT,
    is_only_one BOOLEAN DEFAULT FALSE,
    is_bias BOOLEAN DEFAULT FALSE, -- ลำเอียง
    is_collab BOOLEAN DEFAULT FALSE, -- โดนใจ
    effect_status VARCHAR(50) DEFAULT 'AUTOMATED', -- AUTOMATED, UNVERIFIED, MANUAL_JUDGE
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cards_print ON cards(print_id);
CREATE INDEX idx_cards_type ON cards(card_type);
CREATE INDEX idx_cards_symbol ON cards(symbol);
CREATE INDEX idx_cards_color ON cards(color);

-- 2. DECKS & DECK CARDS
CREATE TABLE decks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_valid BOOLEAN DEFAULT FALSE,
    validation_errors JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE deck_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deck_id UUID REFERENCES decks(id) ON DELETE CASCADE,
    card_id UUID REFERENCES cards(id) ON DELETE RESTRICT,
    slot_type VARCHAR(20) NOT NULL, -- 'MAIN' (50 cards) or 'LIFE' (5 cards)
    quantity INT NOT NULL DEFAULT 1,
    CONSTRAINT check_quantity CHECK (quantity > 0 AND quantity <= 4)
);

-- 3. ROOMS & LOBBY
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code VARCHAR(10) UNIQUE NOT NULL,
    host_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
    game_mode VARCHAR(20) NOT NULL, -- 'DUEL' (2 players) or 'AD_MUA' (3-4 players)
    max_players INT NOT NULL DEFAULT 2,
    status VARCHAR(20) DEFAULT 'WAITING', -- 'WAITING', 'PLAYING', 'FINISHED'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE room_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    deck_id UUID REFERENCES decks(id) ON DELETE SET NULL,
    turn_seat INT NOT NULL, -- 0, 1, 2, 3
    is_ready BOOLEAN DEFAULT FALSE,
    UNIQUE(room_id, turn_seat),
    UNIQUE(room_id, user_id)
);

-- 4. SERVER-AUTHORITATIVE MATCH SESSIONS & STATES
CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    game_mode VARCHAR(20) NOT NULL,
    current_turn_player_id UUID REFERENCES auth.users(id),
    current_phase VARCHAR(50) NOT NULL DEFAULT 'DRAW', -- DRAW, MAIN, BATTLE, END
    turn_number INT NOT NULL DEFAULT 1,
    round_number INT NOT NULL DEFAULT 1,
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, COMPLETED, ABORTED
    winner_id UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- SECURE REDACTED PUBLIC BOARD STATE VIEW FOR REALTIME
CREATE TABLE match_events (
    id BIGSERIAL PRIMARY KEY,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    sequence_num INT NOT NULL,
    actor_id UUID REFERENCES auth.users(id),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_match_events_seq ON match_events(match_id, sequence_num);
