<?php
// Minimal, dependency-free test support: an in-memory SQLite PDO that mirrors
// the 'stations', 'tags' and 'station_tags' MySQL tables closely enough to
// exercise the assistant API's search logic (station_search.php / tag_search.php)
// without requiring a real MySQL server.

declare(strict_types=1);

require_once __DIR__ . '/../../public/app/api/station_search.php';

/**
 * @param list<array{id:int,name:string,search_name:string,country_code:string,
 *                     state?:?string,lang?:?string,category_code?:?string,
 *                     bitrate?:int,codec?:?string,votes?:int,
 *                     image_source?:?string,source?:?string,ats?:?int}> $stations
 * @param list<array{id:int,name:string}> $tags
 * @param list<array{station_id:int,tag_id:int}> $stationTags
 */
function createFixtureDatabase(array $stations, array $tags, array $stationTags): PDO {
    $pdo = new PDO('sqlite::memory:');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    $pdo->exec('
        CREATE TABLE stations (
            id            INTEGER PRIMARY KEY,
            name          TEXT,
            search_name   TEXT,
            country_code  TEXT,
            state         TEXT,
            lang          TEXT,
            category_code TEXT,
            bitrate       INTEGER DEFAULT 0,
            codec         TEXT,
            votes         INTEGER DEFAULT 0,
            image_source  TEXT,
            source        TEXT,
            ats           INTEGER
        )
    ');
    $pdo->exec('
        CREATE TABLE tags (
            id   INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        )
    ');
    $pdo->exec('
        CREATE TABLE station_tags (
            station_id INTEGER NOT NULL,
            tag_id     INTEGER NOT NULL,
            PRIMARY KEY (station_id, tag_id)
        )
    ');

    $stationStmt = $pdo->prepare(
        'INSERT INTO stations
            (id, name, search_name, country_code, state, lang, category_code,
             bitrate, codec, votes, image_source, source, ats)
         VALUES (:id, :name, :search_name, :country_code, :state, :lang, :category_code,
             :bitrate, :codec, :votes, :image_source, :source, :ats)'
    );
    foreach ($stations as $station) {
        $stationStmt->execute([
            ':id'            => $station['id'],
            ':name'          => $station['name'],
            ':search_name'   => $station['search_name'],
            ':country_code'  => $station['country_code'],
            ':state'         => $station['state'] ?? null,
            ':lang'          => $station['lang'] ?? null,
            ':category_code' => $station['category_code'] ?? null,
            ':bitrate'       => $station['bitrate'] ?? 128,
            ':codec'         => $station['codec'] ?? 'MP3',
            ':votes'         => $station['votes'] ?? 0,
            ':image_source'  => $station['image_source'] ?? null,
            ':source'        => $station['source'] ?? null,
            ':ats'           => $station['ats'] ?? null,
        ]);
    }

    $tagStmt = $pdo->prepare('INSERT INTO tags (id, name) VALUES (:id, :name)');
    foreach ($tags as $tag) {
        $tagStmt->execute([':id' => $tag['id'], ':name' => $tag['name']]);
    }

    $stationTagStmt = $pdo->prepare(
        'INSERT INTO station_tags (station_id, tag_id) VALUES (:station_id, :tag_id)'
    );
    foreach ($stationTags as $relation) {
        $stationTagStmt->execute([
            ':station_id' => $relation['station_id'],
            ':tag_id'     => $relation['tag_id'],
        ]);
    }

    return $pdo;
}

/** Standard fixture set reused across tag_search and station_search tests. */
function createStandardFixtureDatabase(): PDO {
    return createFixtureDatabase(
        stations: [
            ['id' => 1, 'name' => 'Talk Radio One', 'search_name' => 'talk radio one', 'country_code' => 'US', 'votes' => 100, 'ats' => 1],
            ['id' => 2, 'name' => 'News Now', 'search_name' => 'news now', 'country_code' => 'US', 'votes' => 50, 'ats' => 1],
            ['id' => 3, 'name' => 'Болтовня FM', 'search_name' => 'болтовня fm', 'country_code' => 'RU', 'votes' => 80, 'ats' => 1],
            // Flagged as not browser-playable: must never be returned.
            ['id' => 4, 'name' => 'Music Wave', 'search_name' => 'music wave', 'country_code' => 'US', 'votes' => 200, 'ats' => 0],
            // Unknown ATS value is still treated as playable.
            ['id' => 5, 'name' => 'Jazz Lounge', 'search_name' => 'jazz lounge', 'country_code' => 'DE', 'votes' => 10, 'ats' => null],
        ],
        tags: [
            ['id' => 1, 'name' => 'Talk'],
            ['id' => 2, 'name' => 'News'],
            ['id' => 3, 'name' => 'Разговоры'],
            ['id' => 4, 'name' => 'Music'],
        ],
        stationTags: [
            ['station_id' => 1, 'tag_id' => 1],
            ['station_id' => 2, 'tag_id' => 2],
            ['station_id' => 3, 'tag_id' => 3],
            ['station_id' => 4, 'tag_id' => 4],
        ],
    );
}
