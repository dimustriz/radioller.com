<?php
require __DIR__ . '/app/api/db.php';

$id = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if ($id === false || $id === null) {
    http_response_code(400);
    $error = 'Invalid station ID';
    $station = null;
} else {
    $stmt = $pdo->prepare(
        'SELECT id, name, country_code, state, lang, category_code, bitrate, codec, votes, url, source, image_source
         FROM stations WHERE id = ? LIMIT 1'
    );
    $stmt->execute([$id]);
    $station = $stmt->fetch();
    if (!$station) {
        http_response_code(404);
        $error = 'Station not found';
    }
}

function h(?string $value): string {
    return htmlspecialchars($value ?? '', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function safeHttpUrl(?string $value): ?string {
    if (!$value || !filter_var($value, FILTER_VALIDATE_URL)) return null;
    $scheme = strtolower((string)parse_url($value, PHP_URL_SCHEME));
    return in_array($scheme, ['http', 'https'], true) ? $value : null;
}

$name = $station ? (string)$station['name'] : ($error ?? 'Station');
$stream = $station ? safeHttpUrl($station['source']) : null;
$website = $station ? safeHttpUrl($station['url']) : null;
$image = $station ? safeHttpUrl($station['image_source']) : null;
$canonical = $station ? 'https://radioller.com/station/' . (int)$station['id'] : 'https://radioller.com/station/';
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= h($name) ?> — Radioller</title>
  <meta name="description" content="<?= h($station ? 'Listen to ' . $name . ' on Radioller.' : $name) ?>">
  <link rel="canonical" href="<?= h($canonical) ?>">
  <meta property="og:title" content="<?= h($name) ?> — Radioller">
  <meta property="og:description" content="Listen to <?= h($name) ?> on Radioller.">
  <meta property="og:type" content="music.radio_station">
  <meta property="og:url" content="<?= h($canonical) ?>">
  <?php if ($image): ?><meta property="og:image" content="<?= h($image) ?>"><?php endif; ?>
  <style>
    :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #1a1412; color: #f5ebe0; }
    body { box-sizing: border-box; display: grid; min-height: 100vh; place-items: center; margin: 0; padding: 24px; }
    main { width: min(100%, 560px); padding: 28px; border: 1px solid #3d3028; border-radius: 20px; background: #241e1a; }
    img { width: 80px; height: 80px; object-fit: cover; border-radius: 14px; }
    h1 { margin: 18px 0 8px; }
    p { color: #b8a99a; }
    audio { width: 100%; margin: 16px 0; }
    a { display: inline-block; margin: 8px 14px 0 0; color: #f59e0b; }
  </style>
</head>
<body>
  <main>
    <?php if ($station): ?>
      <?php if ($image): ?><img src="<?= h($image) ?>" alt=""><?php endif; ?>
      <h1><?= h($name) ?></h1>
      <p>
        <?= h((string)$station['country_code']) ?>
        <?= $station['state'] ? ' · ' . h((string)$station['state']) : '' ?>
        <?= $station['lang'] ? ' · ' . h((string)$station['lang']) : '' ?>
      </p>
      <p>
        <?= h((string)$station['category_code']) ?>
        <?= $station['bitrate'] ? ' · ' . (int)$station['bitrate'] . ' kbps' : '' ?>
        <?= h((string)$station['codec']) ?>
      </p>
      <?php if ($stream): ?><audio controls preload="none" src="<?= h($stream) ?>">Your browser does not support audio playback.</audio><?php endif; ?>
      <?php if ($website): ?><a href="<?= h($website) ?>" rel="noopener noreferrer">Station website</a><?php endif; ?>
      <a href="/app/">Explore Radioller</a>
    <?php else: ?>
      <h1><?= h($name) ?></h1>
      <p><?= h($error ?? '') ?></p>
      <a href="/app/">Explore Radioller</a>
    <?php endif; ?>
  </main>
</body>
</html>
