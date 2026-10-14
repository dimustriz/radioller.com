<?php

require_once __DIR__ . '/playability.php';
require_once __DIR__ . '/tag_search.php';

function stationLink(int $id): string {
    return 'https://radioller.com/station/' . $id;
}

function stationImageLink(int $id, ?string $source): ?string {
    if (!$source) return null;
    if (str_starts_with($source, (string)$id)) {
        return 'https://radioller.com/data/img/' . ($id % 10) . '/' . rawurlencode($source);
    }
    if (filter_var($source, FILTER_VALIDATE_URL)) {
        $scheme = strtolower((string)parse_url($source, PHP_URL_SCHEME));
        if (in_array($scheme, ['http', 'https'], true)) return $source;
    }
    return null;
}

function mapStation(array $row): array {
    $id = (int)$row['id'];
    return [
        'id'       => $id,
        'name'     => $row['name'],
        'country'  => $row['country_code'],
        'state'    => $row['state'],
        'language' => $row['lang'],
        'category' => $row['category_code'],
        'bitrate'  => (int)$row['bitrate'],
        'codec'    => $row['codec'],
        'votes'    => (int)$row['votes'],
        'image'    => stationImageLink($id, $row['image_source'] ?? null),
        'url'      => stationLink($id),
    ];
}

/**
 * Executes the assistant 'search_stations' tool: combines free-text search
 * (station name + tags, via MySQL tables populated by the importer) with an
 * optional country filter, restricted to stations the browser player can
 * play. Returns the exact shape expected by the assistant API / MCP client:
 * totalCount, up to 8 stations, and matchedTags.
 *
 * @throws RuntimeException if the tag catalog can't be queried (callers
 *                           should turn this into a 503 response).
 */
function searchStations(PDO $pdo, string $query, string $country): array {
    // Include stations marked as ATS-compatible and stations whose legacy ATS
    // value is unknown, while excluding stations explicitly marked incompatible.
    $where = [browserPlayableSqlCondition()];
    $params = [];
    $matchedTags = [];

    if ($query !== '') {
        $tagSearch = radiollerTagSearch($query, $pdo);

        $searchConditions = ['search_name LIKE ?'];
        $searchParams = ['%' . addcslashes($query, '\\%_') . '%'];
        if ($tagSearch['stationIds']) {
            $searchConditions[] = 'id IN (' . implode(',', array_fill(0, count($tagSearch['stationIds']), '?')) . ')';
            $searchParams = array_merge($searchParams, $tagSearch['stationIds']);
            $matchedTags = $tagSearch['matchedTags'];
        }
        $where[] = '(' . implode(' OR ', $searchConditions) . ')';
        $params = array_merge($params, $searchParams);
    }

    if ($country !== '') {
        $where[] = 'country_code = ?';
        $params[] = $country;
    }

    $whereClause = implode(' AND ', $where);

    $count = $pdo->prepare("SELECT COUNT(*) FROM stations WHERE $whereClause");
    $count->execute($params);
    $totalCount = (int)$count->fetchColumn();

    $stmt = $pdo->prepare(
        "SELECT id, name, country_code, state, lang, category_code, bitrate, codec, votes, image_source, source
         FROM stations
         WHERE $whereClause
         ORDER BY votes DESC, name ASC
         LIMIT 8"
    );
    $stmt->execute($params);

    return [
        'totalCount' => $totalCount,
        'stations' => array_map('mapStation', $stmt->fetchAll()),
        'matchedTags' => $matchedTags,
    ];
}
