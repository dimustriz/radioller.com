<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=30');

require __DIR__ . '/db.php';
require __DIR__ . '/playability.php';

function respond(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

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

$tool = trim($_GET['tool'] ?? '');

if ($tool === 'search_stations') {
    $query = trim($_GET['query'] ?? '');
    $country = strtoupper(trim($_GET['country'] ?? ''));
    $queryLength = preg_match_all('/./us', $query, $queryCharacters);
    if ($queryLength === false || $queryLength > 120) {
        respond(['error' => 'query must contain at most 120 characters'], 400);
    }
    if ($country !== '' && !preg_match('/^[A-Z]{2}$/', $country)) {
        respond(['error' => 'country must be a two-letter country code'], 400);
    }
    if ($query === '' && $country === '') {
        respond(['error' => 'a query or country is required'], 400);
    }

    // Only include ATS-verified streams plus individually verified browser
    // stream exceptions; keep the source ATS value unchanged.
    $where = [browserPlayableSqlCondition()];
    $params = [];
    if ($query !== '') {
        $where[] = 'search_name LIKE ?';
        $params[] = '%' . addcslashes($query, '\\%_') . '%';
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
    respond([
        'totalCount' => $totalCount,
        'stations' => array_map('mapStation', $stmt->fetchAll()),
    ]);
}

if ($tool === 'get_station') {
    $id = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if ($id === false || $id === null) {
        respond(['error' => 'id must be a positive integer'], 400);
    }

    $stmt = $pdo->prepare(
        'SELECT id, name, country_code, state, lang, category_code, bitrate, codec, votes, image_source, source
         FROM stations WHERE id = ? LIMIT 1'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Station not found'], 404);
    respond(mapStation($row));
}

respond(['error' => 'tool must be search_stations or get_station'], 400);
