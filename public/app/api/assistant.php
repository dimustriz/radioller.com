<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=30');

require __DIR__ . '/db.php';
require __DIR__ . '/station_search.php';

function respond(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
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

    try {
        $result = searchStations($pdo, $query, $country);
    } catch (RuntimeException $error) {
        respond(['error' => $error->getMessage()], 503);
    }
    respond($result);
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
