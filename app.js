/* Parsel360 — tek dosya mantığı
   Canlı servis: https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/
   Zincir:  idariYapi/ilListe
            idariYapi/ilceListe/{ilId}
            idariYapi/mahalleListe/{ilceId}
            parsel/{mahalleId}/{adaNo}/{parselNo}
            parsel/{lat}/{lon}

   v17 düzeltmeleri
   - Bilgi paneli artık haritanın ALTINDA değil, SAĞINDA ayrı bölme. Parsel bilgisi gelince harita kapanmıyor/küçülmüyor;
     bölme kendi içinde kayıyor, harita yerinde kalıyor (Leaflet sadece genişlik değişince yeniden ölçülür).
   - Bölme kapatılabiliyor (× / ▸) — harita tüm alanı kaplar.
   - Ölçüm katmanı değişkenleri "Temizle"den önce tanımlı (eski sürümde Temizle hata veriyordu).
   - Çubuk satır satır akıyor: dar ekranda düğmeler taşmıyor.
   - Servisten gelen metinler HTML olarak yorumlanmadan yazılıyor (kaçış).
   - İndirme koordinat/favori sorgusunda da çalışıyor; bağlantı adresi (#ada=…) paylaşılabilir.
*/
(function () {
  'use strict';

  var API = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/';

  // ---- DOM ----
  function $(id) { return document.getElementById(id); }
  var elIl = $('il'), elIlce = $('ilce'), elMah = $('mah'),
      elAda = $('ada'), elParsel = $('parsel'),
      elLat = $('lat'), elLon = $('lon'),
      elInfo = $('info'), elSp = $('sp'), elMap = $('map'), elBar = $('bar');
  var infoInner = elInfo ? (elInfo.querySelector('.inner') || elInfo) : null;

  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- uzunluk birimi ----
  var UNIT = (localStorage.getItem('p360-unit') === 'mi') ? 'mi' : 'km';
  function lenText(m) {
    var v = UNIT === 'mi' ? m / 1609.344 : m / 1000;
    return fmt(v, v < 10 ? 3 : 2) + ' ' + UNIT;
  }

  // ---- harita ----
  var map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  }).setView([39.0, 35.3], 6);

  // ---- altlıklar ----
  var googleSat = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=s&hl=tr&gl=TR&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 21, maxNativeZoom: 20, attribution: 'Google' }
  );
  var googleHyb = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=y&hl=tr&gl=TR&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 21, maxNativeZoom: 20 }
  );
  var esriSat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, attribution: 'Esri' }
  );
  var esriLbl = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, opacity: 0.9 }
  );
  var osmStreet = L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, maxNativeZoom: 19, opacity: 0.55, attribution: '© OpenStreetMap' }
  );

  var ALL = [googleSat, googleHyb, esriSat, esriLbl, osmStreet];
  function clearBase() { ALL.forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); }); }
  function setBasemap(mode) {
    clearBase();
    if (mode === 'hd') { googleSat.addTo(map); googleHyb.addTo(map); }
    else if (mode === 'sat') { esriSat.addTo(map); esriLbl.addTo(map); }
    else if (mode === 'cadde') { osmStreet.setOpacity(1); osmStreet.addTo(map); }
  }
  setBasemap('hd');

  $('base').addEventListener('change', function (e) {
    osmStreet.setOpacity(e.target.value === 'cadde' ? 1 : 0.55);
    setBasemap(e.target.value);
  });

  // ---- katmanlar ----
  var layerMahalle = L.geoJSON(null, {
    style: { color: '#3d7bff', weight: 2, fill: false, dashArray: '5,4' }
  }).addTo(map);

  var layerParsel = L.geoJSON(null, {
    style: { color: '#2f9e6b', weight: 3, fillColor: '#2f9e6b', fillOpacity: 0.18 }
  }).addTo(map);

  var layerMulti = L.geoJSON(null, {
    style: { color: '#ffd43b', weight: 2, fillColor: '#ffd43b', fillOpacity: 0.10 }
  }).addTo(map);

  // Ölçüm/araç durumu — "Temizle" kullandığı için ÖNCE tanımlanır.
  var toolMode = null, measurePts = [], measureLayer = L.layerGroup().addTo(map), wmsLayer = null;

  var currentGeo = null;
  var currentLookup = null;
  var marker = null;

  var cache = {};
  var state = { mahId: null, ada: null, parsel: null };

  // ---- yardımcılar ----
  function fmt(n, d) {
    if (n === undefined || n === null || n === '') return '—';
    d = (d === undefined) ? 2 : d;
    var x = typeof n === 'number' ? n : parseFloat(String(n).replace(',', '.'));
    if (isNaN(x)) return String(n);
    return x.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function busy(on, text) {
    if (elSp) elSp.style.display = on ? 'inline-block' : 'none';
    if (text !== undefined) show(text);
  }

  function show(html) {
    if (!infoInner) return;
    infoInner.innerHTML = html;
    elInfo.scrollTop = 0;
  }
  function msg(t, cls) { show('<div class="' + (cls || 'msg') + '">' + t + '</div>'); }
  function title(t) { return '<div class="infohd"><span class="t">' + esc(t) + '</span>' +
    '<button id="btn-side-hide" class="sec x" title="Bölmeyi gizle">×</button></div>'; }
  function bindHide() {
    var b = $('btn-side-hide');
    if (b) b.onclick = function () { setSide(false); };
    elInfo.scrollTop = 0;
  }
  function showInfo(t, html) { show(title(t) + html); bindHide(); }
  function showMsg(t, html) { show(html); bindHide(); }

  function req(path, cb) {
    if (cache[path]) { cb(null, cache[path]); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API + path, true);
    xhr.timeout = 90000;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        var d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) {}
        if (d && (d.features || d.type === 'Feature')) { cache[path] = d; }
        cb(null, d, xhr.responseText);
      } else {
        var m = 'HTTP ' + xhr.status;
        try { m = JSON.parse(xhr.responseText).Message || m; } catch (e) {}
        cb(m, null);
      }
    };
    xhr.onerror = function () { cb('Ağ hatası — servise ulaşılamadı', null); };
    xhr.ontimeout = function () { cb('Zaman aşımı', null); };
    xhr.send();
  }

  function optText(p) { return (p && (p.text || p.ilAd || p.ilceAd || p.mahalleAd)) || String(p && p.id); }

  function fill(sel, items, placeholder, keepFirst) {
    if (!sel) return;
    sel.innerHTML = '';
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = placeholder;
    sel.appendChild(o0);
    items.forEach(function (f) {
      var p = f.properties || f;
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = optText(p);
      sel.appendChild(o);
    });
    sel.disabled = items.length === 0;
    if (items.length && keepFirst) sel.selectedIndex = 1;
  }

  // ---- harita yardımcıları ----
  function fitGeom(geojson, pad) {
    try {
      var b = L.geoJSON(geojson).getBounds();
      if (b.isValid()) map.fitBounds(b.pad(pad === undefined ? 0.15 : pad), { animate: true });
    } catch (e) {}
  }
  function boundsOf(geojson) {
    try { return L.geoJSON(geojson).getBounds(); } catch (e) { return null; }
  }
  function centerOfCurrent() {
    if (!currentGeo) return null;
    try {
      var c = L.geoJSON(currentGeo).getBounds().getCenter();
      return isFinite(c.lat) ? c : null;
    } catch (e) { return null; }
  }

  // ---- düzen: yalnızca gerçek boyut değişiminde yeniden ölç ----
  var lastW = 0, lastH = 0;
  function syncMap() {
    if (!elMap || !map) return;
    var r = elMap.getBoundingClientRect();
    if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 2) return;
    lastW = r.width; lastH = r.height;
    map.invalidateSize();
  }

  // ---- sağ bilgi bölmesi ----
  var sideOpen = localStorage.getItem('p360-side') !== '0';
  function setSide(open, noStore) {
    sideOpen = open;
    if (!noStore) { try { localStorage.setItem('p360-side', open ? '1' : '0'); } catch (e) {} }
    if (open) {
      elInfo.style.display = '';
      $('btn-side-toggle').textContent = '▸';
      $('btn-side-toggle').title = 'Bilgi bölmesini gizle';
      $('btn-side-show').style.display = 'none';
    } else {
      elInfo.style.display = 'none';
      $('btn-side-toggle').textContent = '◂';
      $('btn-side-toggle').title = 'Bilgi bölmesini göster';
      $('btn-side-show').style.display = '';
    }
    setTimeout(syncMap, 60);
  }
  $('btn-side-toggle').onclick = function () { setSide(!sideOpen); };
  $('btn-side-show').onclick = function () { setSide(true); };

  // ---- adres çubuğu ----
  function readHash() {
    try { return new URLSearchParams(location.hash.replace(/^#/, '')); } catch (e) { return null; }
  }
  function setHash(params) {
    var s = Object.keys(params).filter(function (k) { return params[k]; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    try { history.replaceState(null, '', s ? '#' + s : location.pathname + location.search); } catch (e) {}
  }

  // ---- il / ilçe / mahalle ----
  function loadIl() {
    busy(true, 'İller yükleniyor…');
    req('idariYapi/ilListe', function (err, d) {
      busy(false);
      if (err) { showMsg('İl listesi', '<div class="err">İl listesi alınamadı: ' + esc(err) + '</div>'); return; }
      fill(elIl, d.features || [], 'İl…');
      showMsg('Parsel bilgisi', '<div class="ok">81 il yüklendi. İl seç.</div>');
    });
  }

  elIl.addEventListener('change', function () {
    var id = elIl.value;
    var sel = elIl.selectedOptions[0];
    var selectedName = sel ? sel.textContent : '';
    setAutoImar(imarKey(selectedName));
    fill(elIlce, [], 'İlçe…'); fill(elMah, [], 'Mahalle…');
    layerMahalle.clearLayers(); layerParsel.clearLayers();
    elAda.value = ''; elParsel.value = '';
    if (!id) { setHash({}); return; }

    req('idariYapi/ilListe', function (e, d) {
      if (!d) return;
      var f = (d.features || []).filter(function (x) { return String(x.properties.id) === String(id); })[0];
      if (f) { layerMahalle.clearLayers(); fitGeom(f, 0.25); }
    });

    busy(true, 'İlçeler yükleniyor…');
    req('idariYapi/ilceListe/' + id, function (err, d) {
      busy(false);
      if (err) { showMsg('Parsel bilgisi', '<div class="err">İlçe listesi alınamadı: ' + esc(err) + '</div>'); return; }
      fill(elIlce, d.features || [], 'İlçe…');
      showMsg('Parsel bilgisi', '<div class="ok"><b>' + esc(selectedName) + '</b> — ' + (d.features || []).length + ' ilçe. İlçe seç.</div>');
    });
  });

  elIlce.addEventListener('change', function () {
    var id = elIlce.value;
    fill(elMah, [], 'Mahalle…');
    layerParsel.clearLayers(); elAda.value = ''; elParsel.value = '';
    if (!id) return;

    busy(true, 'Mahalleler yükleniyor…');
    req('idariYapi/mahalleListe/' + id, function (err, d) {
      busy(false);
      if (err) { showMsg('Parsel bilgisi', '<div class="err">Mahalle listesi alınamadı: ' + esc(err) + '</div>'); return; }
      fill(elMah, d.features || [], 'Mahalle…');
      var nm = elIlce.selectedOptions[0] ? elIlce.selectedOptions[0].textContent : '';
      showMsg('Parsel bilgisi', '<div class="ok"><b>' + esc(nm) + '</b> — ' + (d.features || []).length + ' mahalle. Mahalle seç, sonra ada/parsel gir.</div>');
      var f = (d.features || [])[0];
      if (f && f.geometry) fitGeom(f, 0.25);
    });
  });

  elMah.addEventListener('change', function () {
    var id = elMah.value;
    layerParsel.clearLayers(); elAda.value = ''; elParsel.value = '';
    if (!id) return;

    busy(true, 'Mahalle sınırı getiriliyor…');
    req('idariYapi/mahalleListe/' + elIlce.value, function (err, d) {
      busy(false);
      if (err || !d) { showMsg('Parsel bilgisi', '<div class="err">Mahalle sınırı alınamadı: ' + esc(err || '') + '</div>'); return; }
      var f = (d.features || []).filter(function (x) { return String(x.properties.id) === String(id); })[0];
      var name = elMah.selectedOptions[0] ? elMah.selectedOptions[0].textContent : '';
      if (!f) { showMsg('Parsel bilgisi', '<div class="err">Mahalle sınırı bulunamadı.</div>'); return; }
      layerMahalle.clearLayers();
      layerMahalle.addData(f);
      fitGeom(f, 0.12);
      var b = boundsOf(f), c = b ? b.getCenter() : null;
      showMsg('Mahalle', '<div class="ok"><b>' + esc(name) + '</b> mahallesi haritada.</div>' +
        '<div class="hint">Şimdi <b>Ada</b> ve <b>Parsel</b> girip Sorgula\'ya bas. Merkez: ' +
        (c ? (c.lat.toFixed(5) + ', ' + c.lng.toFixed(5)) : '—') + '</div>');
      if (c) { elLat.value = c.lat.toFixed(6); elLon.value = c.lng.toFixed(6); }
    });
  });

  // ---- parsel ----
  function lookupUrl(lookup, fmtq) {
    if (!lookup) return null;
    var p = lookup.p || {}, base = null;
    if (lookup.type === 'coord') {
      base = API + 'parsel/' + lookup.lat + '/' + lookup.lon;
      return fmtq ? API + 'parsel/download/' + idOf(p, lookup) + '/' + fmtq : base;
    }
    if (lookup.type === 'sa') {
      var mh = (p.mahalleId !== undefined && p.mahalleId !== null && p.mahalleId !== '') ? p.mahalleId : lookup.mahId;
      if ((mh === undefined || mh === null || mh === '') && p.id) mh = String(p.id).split('_')[0];
      if (mh === undefined || mh === null || mh === '') return null;
      base = API + 'parsel/' + mh + '/' + lookup.ada + '/' + lookup.parsel;
      return fmtq ? API + 'parsel/download/' + mh + '/' + lookup.ada + '/' + lookup.parsel + '/' + fmtq : base;
    }
    return null;
  }
  function idOf(p, lookup) {
    if (p && p.id !== undefined && p.id !== null && p.id !== '') return String(p.id).split('_')[0];
    if (lookup && lookup.mahId) return lookup.mahId;
    if (state.mahId && lookup && lookup.ada && lookup.parsel) return state.mahId;
    return null;
  }

  function drawParsel(geojson, source) {
    if (!geojson || (!geojson.geometry && !geojson.properties)) {
      showMsg('Parsel bilgisi', '<div class="err">Parsel bulunamadı.</div>'); return;
    }
    currentGeo = geojson;
    if ($('multi').checked && geojson.geometry) {
      layerMulti.addData(geojson);
    } else {
      layerParsel.clearLayers();
      if (geojson.geometry) layerParsel.addData(geojson);
    }
    if (geojson.geometry) fitGeom(geojson, 0.35);

    var p = geojson.properties || {};
    if (p.mahalleId) state.mahId = p.mahalleId;
    if (p.adaNo) state.ada = p.adaNo;
    if (p.parselNo) state.parsel = p.parselNo;

    var rows = [
      ['Özet', p.ozet],
      ['İl / İlçe', (p.ilAd || '—') + ' / ' + (p.ilceAd || '—')],
      ['Mahalle', p.mahalleAd],
      ['Ada / Parsel', (p.adaNo || '—') + ' / ' + (p.parselNo || '—')],
      ['Alan (m²)', fmt(p.alan)],
      ['Nitelik', p.nitelik],
      ['Pafta', p.pafta],
      ['Mevkii', p.mevkii || '—'],
      ['Zemin Kmdurum', p.zeminKmdurum],
      ['Durum', String(p.durum) === '1' ? 'Aktif' : p.durum]
    ];
    var html = '<div class="ok">Parsel bulundu — <span class="hint">' + esc(source) + '</span></div><div class="kv">';
    rows.forEach(function (r) {
      if (r[1] === undefined || r[1] === null || r[1] === '') return;
      html += '<span>' + esc(r[0]) + '</span><span><b>' + esc(r[1]) + '</b></span>';
    });
    html += '</div>';

    if (geojson.geometry && geojson.geometry.coordinates) {
      var flat = [];
      (function walk(a) {
        if (typeof a[0] === 'number') flat.push(a);
        else if (a && a.forEach) a.forEach(walk);
      })(geojson.geometry.coordinates);
      if (flat.length) {
        html += '<div class="coords" style="margin-top:7px">' + flat.length + ' nokta • ilk: ' +
                flat[0].map(function (x) { return x.toFixed(6); }).join(', ') + '</div>';
      }
    }

    var u = lookupUrl(currentLookup, null);
    if (u) {
      html += '<div class="hint" style="margin-top:8px">Servis kaydı: <span class="coords">' + esc(u) + '</span></div>';
    }
    showInfo('Parsel bilgisi', html);
  }

  function sorgula() {
    var mahId = elMah.value, ada = elAda.value.trim(), parsel = elParsel.value.trim();
    if (!mahId) { showMsg('Parsel bilgisi', '<div class="err">Önce mahalle seç.</div>'); return; }
    if (!ada || !parsel) { showMsg('Parsel bilgisi', '<div class="err">Ada ve parsel numarasını gir (ör. 1559 / 883).</div>'); return; }

    var path = 'parsel/' + mahId + '/' + ada + '/' + parsel;
    busy(true, title('Parsel bilgisi') + '<div class="msg">Parsel sorgulanıyor… ' + esc(ada + '/' + parsel) + '</div>');
    req(path, function (err, d) {
      busy(false);
      if (err || !d) {
        showMsg('Parsel bilgisi', '<div class="err"><b>' + esc(ada) + '/' + esc(parsel) + '</b> bulunamadı.<br><span class="hint">' + esc(err || 'Kayıt yok') + '</span></div>');
        return;
      }
      currentLookup = { type: 'sa', p: d.properties || {}, mahId: mahId, ada: ada, parsel: parsel };
      drawParsel(d, 'parsel/' + mahId + '/' + ada + '/' + parsel);
      setHash({ il: elIl.value, ilce: elIlce.value, mah: mahId, ada: ada, parsel: parsel });
    });
  }

  $('btn-sorgu').addEventListener('click', sorgula);
  elAda.addEventListener('keydown', function (e) { if (e.key === 'Enter') elParsel.focus(); });
  elParsel.addEventListener('keydown', function (e) { if (e.key === 'Enter') sorgula(); });

  // ---- koordinat ----
  function koordSor() {
    var la = parseFloat(String(elLat.value).replace(',', '.')),
        lo = parseFloat(String(elLon.value).replace(',', '.'));
    if (isNaN(la) || isNaN(lo)) { showMsg('Parsel bilgisi', '<div class="err">Geçerli enlem/boylam gir.</div>'); return; }
    if (la < 35 || la > 43 || lo < 25 || lo > 46) { showMsg('Parsel bilgisi', '<div class="err">Koordinat Türkiye sınırları dışında (enlem 35-43, boylam 25-46).</div>'); return; }

    busy(true, title('Parsel bilgisi') + '<div class="msg">Koordinat sorgulanıyor…</div>');
    req('parsel/' + la + '/' + lo, function (err, d) {
      busy(false);
      if (err || !d) { showMsg('Parsel bilgisi', '<div class="err">Bu noktada parsel yok.<br><span class="hint">' + esc(err || '') + '</span></div>'); return; }
      layerMahalle.clearLayers();
      if (marker) map.removeLayer(marker);
      marker = L.circleMarker([la, lo], { radius: 6, color: '#d9822b', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map);
      currentLookup = { type: 'coord', lat: la, lon: lo, p: d.properties || {} };
      drawParsel(d, 'parsel/' + la + '/' + lo);
    });
  }
  $('btn-coord').addEventListener('click', koordSor);
  elLon.addEventListener('keydown', function (e) { if (e.key === 'Enter') koordSor(); });

  // ---- sekmeler ----
  function tab(which) {
    ['adm', 'coord', 'imar'].forEach(function (k) {
      var pane = $('pane-' + k);
      if (pane) pane.classList.toggle('on', k === which);
      var b = $('tb-' + k);
      if (b) b.className = (k === which) ? 'on' : 'sec';
    });
    setTimeout(syncMap, 60);
  }
  $('tb-adm').addEventListener('click', function () { tab('adm'); });
  $('tb-coord').addEventListener('click', function () { tab('coord'); });
  $('tb-imar').addEventListener('click', function () { tab('imar'); });

  // ---- indirme menüsü ----
  $('btn-dl').addEventListener('click', function (e) {
    e.stopPropagation();
    var m = $('dlmenu');
    m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
  });
  document.addEventListener('click', function () { $('dlmenu').style.display = 'none'; });
  Array.prototype.forEach.call(document.querySelectorAll('#dlmenu button'), function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      $('dlmenu').style.display = 'none';
      indir(b.getAttribute('data-fmt'));
    });
  });

  function indir(fmtq) {
    var u = lookupUrl(currentLookup, fmtq);
    if (!u) { showMsg('İndirme', '<div class="err">İndirmek için ada/parsel sorgula ya da haritadan bir parsel seç.</div>'); return; }
    showInfo('İndirme', '<div class="ok">Hazır: <b>' + esc(String(fmtq).toUpperCase()) + '</b></div>' +
      '<div class="coords" style="margin-top:6px">' + esc(u) + '</div>' +
      '<div class="hint" style="margin-top:6px">Dosya açılmazsa <a href="' + esc(u) + '" target="_blank" rel="noopener">buraya dokun</a> ya da sağ tık → “Hedefi farklı kaydet”.</div>' +
      '<div class="hint" style="margin-top:4px">Diğerleri: ' +
      ['kml', 'json', 'dxf', 'shp'].map(function (f) {
        return '<a href="' + esc(lookupUrl(currentLookup, f)) + '">' + f.toUpperCase() + '</a>';
      }).join(' · ') + '</div>');
    window.open(u, '_blank');
  }

  // ---- temizle ----
  $('btn-clear').addEventListener('click', function () {
    layerMahalle.clearLayers(); layerParsel.clearLayers(); layerMulti.clearLayers();
    measureLayer.clearLayers(); measurePts = []; toolMode = null;
    currentGeo = null; currentLookup = null;
    if (marker) { map.removeLayer(marker); marker = null; }
    elIl.value = ''; fill(elIlce, [], 'İlçe…'); fill(elMah, [], 'Mahalle…');
    elAda.value = ''; elParsel.value = '';
    state = { mahId: null, ada: null, parsel: null };
    setAutoImar(null);
    map.setView([39.0, 35.3], 6);
    setHash({});
    showMsg('Parsel bilgisi', '<div class="ok">Temizlendi.</div>');
  });

  // ---- favoriler ----
  var FAV_KEY = 'kadastro-favoriler';
  function readFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeFavs(arr) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); }
    catch (e) { showMsg('Favoriler', '<div class="err">Favoriler kaydedilemedi (depolama dolu olabilir).</div>'); }
  }
  function renderFavs() {
    var arr = readFavs();
    $('favlist').innerHTML = arr.length ? arr.map(function (x, i) {
      return '<div class="favrow"><span><b>' + esc(x.ozet) + '</b> · ' + esc(x.alan || '') + ' m²</span>' +
        '<span><button class="sec" data-fi="' + i + '">Göster</button> <button class="sec" data-fd="' + i + '">Sil</button></span></div>';
    }).join('') : '<span class="hint">Favori yok.</span>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-fi]'), function (b) {
      b.onclick = function () {
        var x = arr[+b.dataset.fi];
        if (x && x.geo) { currentLookup = { type: 'fav', p: x.geo.properties || {} }; drawParsel(x.geo, 'favori'); }
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-fd]'), function (b) {
      b.onclick = function () { arr.splice(+b.dataset.fd, 1); writeFavs(arr); renderFavs(); };
    });
  }
  $('btn-tools').onclick = function () {
    $('toolpanel').classList.toggle('on');
    renderFavs();
    setTimeout(syncMap, 60);
  };
  $('btn-fav').onclick = function () {
    if (!currentGeo) { showMsg('Favoriler', '<div class="err">Önce bir parsel sorgula.</div>'); return; }
    var arr = readFavs(), p = currentGeo.properties || {};
    if (!arr.some(function (x) { return x.ozet === p.ozet; })) arr.push({ ozet: p.ozet, alan: p.alan, geo: currentGeo });
    writeFavs(arr); renderFavs();
    showMsg('Favoriler', '<div class="ok">' + esc(p.ozet || 'Parsel') + ' favorilere eklendi.</div>');
  };
  $('multi').onchange = function () { if (!this.checked) layerMulti.clearLayers(); };

  $('btn-help').onclick = function () {
    showInfo('Nasıl kullanılır', '<div class="kv">' +
      '<span>Ada/parsel</span><span><b>İdari</b> → İl → İlçe → Mahalle → Ada + Parsel → <b>Sorgula</b></span>' +
      '<span>Haritadan</span><span>Haritaya dokun: o noktanın parseli ve bilgileri sağda gelir.</span>' +
      '<span>Ölçüm</span><span><b>Ölç</b> → noktaları işaretle → <b>Ölçümü Bitir</b> (Mesafe/Alan).</span>' +
      '<span>İndirme</span><span><b>İndir ▾</b> → KML / GeoJSON / DXF / SHP.</span>' +
      '<span>Favori</span><span><b>☆ Favori</b> ile sakla, <b>Araçlar</b> içinden geri çağır.</span>' +
      '<span>e-İmar</span><span>Yetkili belediyelerin portalını açar; bazı illerde imar katmanı haritaya bindirilir.</span>' +
      '<span>Bölme</span><span>Sağ bölmeyi <b>×</b> ile gizle, haritanın köşesindeki <b>▸/◂</b> ile geri getir.</span>' +
      '</div>');
  };

  // ---- GPS ----
  var hasGeo = !!(navigator.geolocation && (window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost'));
  if (hasGeo) {
    $('btn-gps').onclick = function () {
      busy(true, title('Parsel bilgisi') + '<div class="msg">GPS konumu alınıyor…</div>');
      bindHide();
      navigator.geolocation.getCurrentPosition(function (p) {
        elLat.value = p.coords.latitude.toFixed(7); elLon.value = p.coords.longitude.toFixed(7);
        busy(false); tab('coord'); koordSor();
      }, function (e) {
        busy(false);
        if (e.code === 1) {
          showInfo('Konum izni', '<div class="err"><b>Konum izni reddedildi.</b></div>' +
            '<div class="hint" style="line-height:1.7">Safari’de adres çubuğundaki <b>Sayfa Menüsü (aA)</b> → <b>Web Sitesi Ayarları</b> → <b>Konum</b> → <b>İzin Ver</b>.<br>' +
            'Olmazsa: iPhone <b>Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri → Safari Web Siteleri</b>.</div>' +
            '<button id="gps-retry" style="margin-top:8px">GPS’yi Tekrar Dene</button>');
          setTimeout(function () { var r = $('gps-retry'); if (r) r.onclick = function () { $('btn-gps').click(); }; }, 0);
        } else if (e.code === 2) showMsg('Parsel bilgisi', '<div class="err">Konum belirlenemedi. GPS/Wi-Fi açık olmalı.</div>');
        else if (e.code === 3) showMsg('Parsel bilgisi', '<div class="err">Konum isteği zaman aşımına uğradı. Tekrar dene.</div>');
        else showMsg('Parsel bilgisi', '<div class="err">Konum alınamadı: ' + esc(e.message) + '</div>');
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    };
  } else {
    $('btn-gps').style.display = 'none';
  }

  // ---- ölçüm ----
  function hav(a, b) {
    var R = 6371000, r = Math.PI / 180, p1 = a.lat * r, p2 = b.lat * r,
        dp = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
    var q = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(q));
  }
  function polyArea(ps) {
    if (ps.length < 3) return 0;
    var R = 6378137, lat0 = ps.reduce(function (s, p) { return s + p.lat; }, 0) / ps.length * Math.PI / 180, a = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], q = ps[(i + 1) % ps.length];
      var x1 = R * p.lng * Math.PI / 180 * Math.cos(lat0), y1 = R * p.lat * Math.PI / 180,
          x2 = R * q.lng * Math.PI / 180 * Math.cos(lat0), y2 = R * q.lat * Math.PI / 180;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  }
  function updateMeasure() {
    measureLayer.clearLayers();
    if (!measurePts.length) return;
    L.polyline(measurePts, { color: '#ff5c8a', weight: 3 }).addTo(measureLayer);
    measurePts.forEach(function (p) {
      L.circleMarker(p, { radius: 4, color: '#fff', fillColor: '#ff5c8a', fillOpacity: 1 }).addTo(measureLayer);
    });
  }
  $('btn-measure').onclick = function () {
    $('toolpanel').classList.add('on');
    toolMode = 'measure'; measurePts = []; updateMeasure();
    showMsg('Ölçüm', '<div class="ok">Haritada ölçüm noktalarına dokun. Sonra <b>Ölçümü Bitir</b>.</div>');
  };
  $('btn-measure-clear').onclick = function () { toolMode = null; measurePts = []; measureLayer.clearLayers(); showMsg('Ölçüm', '<div class="ok">Ölçüm temizlendi.</div>'); };
  $('btn-measure-finish').onclick = function () {
    var typ = $('measure-type').value;
    if (typ === 'area') {
      if (measurePts.length > 2) L.polygon(measurePts, { color: '#ff5c8a', fillOpacity: .15 }).addTo(measureLayer);
      showMsg('Ölçüm', '<div class="ok">Yaklaşık alan: <b>' + fmt(polyArea(measurePts)) + ' m²</b></div>');
    } else {
      var d = 0;
      for (var i = 1; i < measurePts.length; i++) d += hav(measurePts[i - 1], measurePts[i]);
      showMsg('Ölçüm', '<div class="ok">Yaklaşık mesafe: <b>' + lenText(d) + '</b> <span class="hint">(' + fmt(d) + ' m)</span></div>');
    }
    toolMode = null;
  };

  // ---- açık imar servisleri ----
  var IMAR_LAYERS = {
    ankara: {
      title: 'Ankara 1/1000 Uygulama İmar Planı',
      url: 'https://baskentcbs.ankara.bel.tr/server/services/plan/UIP_Goruntuleme/MapServer/WMSServer',
      layers: '1,2,3,4,5,6,7,8,9,10,12,13,14,16,17,18,19',
      version: '1.3.0'
    }
  };
  var activeImarKey = null;
  function setAutoImar(key) {
    if (wmsLayer) { map.removeLayer(wmsLayer); wmsLayer = null; }
    activeImarKey = (key && IMAR_LAYERS[key]) ? key : null;
    var b = $('btn-auto-imar'), s = $('wms-status');
    if (!b || !s) return;
    if (!activeImarKey) {
      b.disabled = true; b.textContent = 'İmar katmanı yok'; b.style.background = '';
      s.textContent = 'Bu il için doğrulanmış açık WMS/ArcGIS imar servisi bulunamadı.';
      return;
    }
    var cfg = IMAR_LAYERS[activeImarKey];
    wmsLayer = L.tileLayer.wms(cfg.url, { layers: cfg.layers, format: 'image/png', transparent: true, opacity: .68, version: cfg.version }).addTo(map);
    b.disabled = false; b.textContent = '✓ İmar katmanı'; b.style.background = '#168f55';
    s.textContent = cfg.title + ' · kadastro üzerine bindirildi';
  }
  $('btn-auto-imar').onclick = function () {
    if (!activeImarKey) return;
    if (wmsLayer && map.hasLayer(wmsLayer)) { map.removeLayer(wmsLayer); this.textContent = 'İmar katmanı aç'; this.style.background = ''; }
    else { setAutoImar(activeImarKey); }
  };
  $('btn-wms-clear').onclick = function () {
    if (wmsLayer) { map.removeLayer(wmsLayer); wmsLayer = null; }
    $('btn-auto-imar').textContent = activeImarKey ? 'İmar katmanını aç' : 'İmar katmanı yok';
    $('btn-auto-imar').style.background = '';
    showMsg('İmar katmanı', '<div class="ok">İmar katmanı kapatıldı.</div>');
  };

  $('btn-google').onclick = function () {
    var c = centerOfCurrent() || map.getCenter();
    window.open('https://www.google.com/maps/search/?api=1&query=' + c.lat + ',' + c.lng, '_blank');
  };
  $('btn-street').onclick = function () {
    var c = centerOfCurrent();
    if (!c) { showMsg('Street View', '<div class="err">Street View için önce bir parsel sorgula.</div>'); return; }
    window.open('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + c.lat + ',' + c.lng, '_blank');
  };
  $('btn-tkgm').onclick = function () { window.open('https://parselsorgu.tkgm.gov.tr/', '_blank'); };

  // ---- e-İmar portalları ----
  var IMAR = {
    'adana':     { url: 'https://keos.adana.bel.tr',              ad: 'Adana BB — KEOS İmar Sorgu' },
    'ankara':    { url: 'https://eimar.ankara.bel.tr',            ad: 'Ankara BB — CBSIMAR e-İmar' },
    'antalya':   { url: 'https://kbs.antalya.bel.tr/portalvatandas/', ad: 'Antalya BB — İmar Plan Uygulaması' },
    'balikesir': { url: 'https://imar.balikesir.bel.tr',          ad: 'Balıkesir BB — İmar Sorgu' },
    'gaziantep': { url: 'https://keos.gaziantep.bel.tr',          ad: 'Gaziantep BB — KEOS' },
    'istanbul':  { url: 'https://sehirharitasi.ibb.gov.tr',       ad: 'İBB — Şehir Haritası / İmar' },
    'izmir':     { url: 'https://cbs.izmir.bel.tr',               ad: 'İzmir BB — CBS' },
    'kayseri':   { url: 'https://cbs.kayseri.bel.tr',             ad: 'Kayseri BB — CBS Kent Rehberi' },
    'mersin':    { url: 'https://eplan.csb.gov.tr/e-plan/html/imarDurumu.html', ad: 'Mersin — e-Plan / İlçe e-İmar', districts: {
      'mezitli': 'https://keos.mezitli.bel.tr/imardurumu/',
      'yenisehir': 'https://keos.yenisehir.bel.tr/imardurumu/'
    }},
    'mugla':     { url: 'https://cbs.mugla.bel.tr',               ad: 'Muğla BB — CBS' },
    'ordu':      { url: 'https://cbs.ordu.bel.tr',                ad: 'Ordu BB — Adres Bilgi Kartı' }
  };

  function imarKey(s) {
    return (s || '').toLowerCase()
      .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
      .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
      .replace(/\s+/g, '');
  }

  (function initImar() {
    var sel = $('imar-il');
    if (!sel) return;
    var keys = Object.keys(IMAR).sort(function (a, b) { return IMAR[a].ad.localeCompare(IMAR[b].ad, 'tr'); });
    sel.innerHTML = '<option value="">İl…</option>';
    keys.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = IMAR[k].ad.split('—')[0].trim();
      sel.appendChild(o);
    });
  })();

  $('imar-il').addEventListener('change', function () {
    var k = $('imar-il').value;
    setAutoImar(k);
    var ilceSel = $('imar-ilce');
    ilceSel.innerHTML = '<option value="">İlçe yükleniyor…</option>';
    ilceSel.disabled = true;
    $('btn-imar').disabled = true;
    if (!k) { ilceSel.innerHTML = '<option value="">İlçe…</option>'; showMsg('e-İmar', '<div class="err">e-imar için il seç.</div>'); return; }
    var it = IMAR[k];

    req('idariYapi/ilListe', function (err, d) {
      var il = !err && d && (d.features || []).filter(function (f) {
        return imarKey(f.properties.text) === k;
      })[0];
      if (!il) {
        ilceSel.innerHTML = '<option value="genel">İl geneli</option>';
        ilceSel.disabled = false; $('btn-imar').disabled = false;
        return;
      }
      fitGeom(il, 0.18);
      req('idariYapi/ilceListe/' + il.properties.id, function (e2, d2) {
        ilceSel.innerHTML = '<option value="">İlçe seç…</option>';
        (d2 && d2.features || []).forEach(function (f) {
          var o = document.createElement('option');
          o.value = f.properties.id; o.textContent = f.properties.text;
          ilceSel.appendChild(o);
        });
        ilceSel.disabled = false;
      });
    });

    showInfo('e-İmar', '<div class="ok"><b>' + esc(it.ad) + '</b></div>' +
      '<div class="kv"><span>Kurum</span><span><b>' + esc(it.ad.split('—')[0].trim()) + '</b></span>' +
      '<span>Adres</span><span><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.url) + '</a></span></div>' +
      '<div class="hint" style="margin-top:8px">İlçeyi seç; belediyenin kendi portalı açılır. Portal içinde ada/parseli yeniden girmen gerekebilir.</div>');
  });

  function selectedImarUrl() {
    var k = $('imar-il').value, it = IMAR[k];
    if (!it) return '';
    var opt = $('imar-ilce').selectedOptions[0];
    var dk = opt ? imarKey(opt.textContent) : '';
    return (it.districts && it.districts[dk]) || it.url;
  }

  $('imar-ilce').addEventListener('change', function () {
    var k = $('imar-il').value;
    var ilce = $('imar-ilce').selectedOptions[0];
    $('btn-imar').disabled = !k || !$('imar-ilce').value;
    if (k && ilce && $('imar-ilce').value) {
      var u = selectedImarUrl(), ozel = IMAR[k].districts && IMAR[k].districts[imarKey(ilce.textContent)];
      showInfo('e-İmar', '<div class="ok"><b>' + esc(ilce.textContent) + '</b> e-İmar bağlantısı hazır.</div>' +
        '<div class="kv"><span>Portal</span><span><b>' + esc(ozel ? 'İlçe Belediyesi KEOS' : IMAR[k].ad) + '</b></span>' +
        '<span>Adres</span><span class="coords">' + esc(u) + '</span></div>' +
        (activeImarKey ? '<div class="ok">✓ Açık imar katmanı haritada gösteriliyor.</div>'
                       : '<div class="hint">Bu ilçe için dışarıdan kullanılabilen açık WMS bulunamadı; resmî portala yönlendirilir.</div>'));
    }
  });

  $('btn-imar').addEventListener('click', function () {
    var u = selectedImarUrl();
    if (!u) { showMsg('e-İmar', '<div class="err">e-imar için il ve ilçe seç.</div>'); return; }
    window.open(u, '_blank');
  });

  // ---- haritaya tıklama ----
  map.on('click', function (e) {
    if (toolMode === 'measure') {
      measurePts.push(e.latlng); updateMeasure();
      var typ = $('measure-type').value, val = 0;
      if (typ === 'distance') { for (var i = 1; i < measurePts.length; i++) val += hav(measurePts[i - 1], measurePts[i]); }
      else val = polyArea(measurePts);
      showMsg('Ölçüm', '<div class="ok">' + (typ === 'distance' ? 'Mesafe: <b>' + lenText(val) + '</b>' : 'Alan: <b>' + fmt(val) + ' m²</b>') +
        ' <span class="hint">· ' + measurePts.length + ' nokta</span></div>');
      return;
    }
    elLat.value = e.latlng.lat.toFixed(6);
    elLon.value = e.latlng.lng.toFixed(6);
    tab('coord');
    koordSor();
  });

  // ---- başlat ----
  setTimeout(function () { var s = $('splash'); if (s) s.classList.add('hide'); }, 900);
  setTimeout(function () { var s = $('splash'); if (s) s.style.display = 'none'; }, 1550);

  window.addEventListener('load', function () { setTimeout(syncMap, 200); syncMap(); });
  window.addEventListener('resize', function () { syncMap(); });
  window.addEventListener('orientationchange', function () { setTimeout(syncMap, 250); });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { clearTimeout(window.__p360t); window.__p360t = setTimeout(syncMap, 80); });
    if (elMap) ro.observe(elMap);
    if (elBar) ro.observe(elBar);
  }

  setSide(sideOpen, true);
  loadIl();
  setTimeout(syncMap, 300);

  // ---- paylaşılabilir adres (#ada=…) ----
  (function applyHash() {
    var h = readHash();
    if (!h || !h.get('ada') || !h.get('mah')) return;
    var ada = h.get('ada'), parsel = h.get('parsel');
    if (ada) elAda.value = ada;
    if (parsel) elParsel.value = parsel;
    req('idariYapi/ilListe', function (e, d) {
      var il = d && (d.features || []).filter(function (f) { return String(f.properties.id) === String(h.get('il')); })[0];
      if (!il) return;
      elIl.value = il.properties.id;
      req('idariYapi/ilceListe/' + il.properties.id, function (e2, d2) {
        var ilce = d2 && (d2.features || []).filter(function (f) { return String(f.properties.id) === String(h.get('ilce')); })[0];
        if (!ilce) return;
        elIlce.value = ilce.properties.id;
        req('idariYapi/mahalleListe/' + ilce.properties.id, function (e3, d3) {
          var ma = d3 && (d3.features || []).filter(function (f) { return String(f.properties.id) === String(h.get('mah')); })[0];
          if (!ma) return;
          fill(elMah, d3.features || [], 'Mahalle…');
          elMah.value = ma.properties.id;
          sorgula();
        });
      });
    });
  })();
})();