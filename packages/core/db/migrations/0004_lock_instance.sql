-- DiriZ 0004 — Instance Locking (§12.1)
-- Verhindert parallele Nutzung derselben Instanz für überlappende Tasks.
-- `locked_until` ist ein ISO-8601-Zeitstempel; NULL bedeutet "frei".
ALTER TABLE instances ADD COLUMN locked_until TEXT;