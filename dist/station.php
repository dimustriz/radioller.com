<?php
$id = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if ($id === false || $id === null) {
    http_response_code(400);
    $id = 0;
}
$stationId = json_encode($id, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
$canonical = $id ? 'https://radioller.com/station/' . $id : 'https://radioller.com/station/';
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Radio station — Radioller</title>
  <meta name="description" content="Listen to radio stations on Radioller.">
  <link rel="canonical" href="<?= htmlspecialchars($canonical, ENT_QUOTES, 'UTF-8') ?>">
  <meta property="og:title" content="Radio station — Radioller">
  <meta property="og:description" content="Listen to radio stations on Radioller.">
  <meta property="og:type" content="music.radio_station">
  <meta property="og:url" content="<?= htmlspecialchars($canonical, ENT_QUOTES, 'UTF-8') ?>">
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
    <section id="station" aria-live="polite">
      <h1>Loading station…</h1>
      <p id="station-status">Loading station details.</p>
    </section>
    <a href="/app/">Explore Radioller</a>
  </main>
  <script>
    (() => {
      const stationId = <?= $stationId ?>;
      const section = document.getElementById('station');
      const status = document.getElementById('station-status');
      if (!stationId) {
        status.textContent = 'Invalid station ID.';
        return;
      }

      function safeHttpUrl(value) {
        if (typeof value !== 'string') return null;
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
        } catch {
          return null;
        }
      }

      function addMeta(property, content) {
        let meta = document.querySelector(`meta[property="${property}"]`);
        if (!meta) {
          meta = document.createElement('meta');
          meta.setAttribute('property', property);
          document.head.append(meta);
        }
        meta.setAttribute('content', content);
      }

      function addText(tag, text) {
        const element = document.createElement(tag);
        element.textContent = text;
        section.append(element);
        return element;
      }

      fetch(`/app/api/station.php?id=${stationId}`, { cache: 'no-store' })
        .then(async (response) => {
          const station = await response.json();
          if (!response.ok) throw new Error(station.error || 'Station details are unavailable.');
          return station;
        })
        .then((station) => {
          const name = typeof station.nm === 'string' && station.nm ? station.nm : 'Radio station';
          const title = `${name} — Radioller`;
          document.title = title;
          document.querySelector('meta[name="description"]')?.setAttribute('content', `Listen to ${name} on Radioller.`);
          addMeta('og:title', title);
          addMeta('og:description', `Listen to ${name} on Radioller.`);

          section.replaceChildren();
          const imageSource = typeof station.is === 'string' ? station.is : '';
          const image = imageSource.startsWith(String(station.id))
            ? `/data/img/${Number(station.id) % 10}/${encodeURIComponent(imageSource)}`
            : safeHttpUrl(imageSource);
          if (image) {
            const img = document.createElement('img');
            img.src = image;
            img.alt = '';
            section.append(img);
            addMeta('og:image', new URL(image, location.origin).href);
          }

          addText('h1', name);
          const locationParts = [station.cc, station.st, station.lang].filter((value) => typeof value === 'string' && value);
          if (locationParts.length) addText('p', locationParts.join(' · '));
          const formatParts = [station.categoryCode, station.bt ? `${station.bt} kbps` : null, station.cd]
            .filter((value) => typeof value === 'string' && value);
          if (formatParts.length) addText('p', formatParts.join(' · '));

          const stream = safeHttpUrl(station.sr);
          if (stream && new URL(stream).protocol === 'https:') {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.preload = 'none';
            audio.src = stream;
            section.append(audio);
          } else if (stream && new URL(stream).protocol === 'http:') {
            addText('p', 'This station only provides an HTTP stream, which browsers block on secure pages. Listen in the Radioller app below.');
          }

          const website = safeHttpUrl(station.ur);
          if (website) {
            const link = document.createElement('a');
            link.href = website;
            link.rel = 'noopener noreferrer';
            link.textContent = 'Station website';
            section.append(link);
          }
        })
        .catch((error) => {
          status.textContent = error instanceof Error ? error.message : 'Station details are unavailable.';
        });
    })();
  </script>
</body>
</html>
