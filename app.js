/* Parsel360 — tek dosya mantığı
   Servis: https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/
   Zincir:  idariYapi/ilListe → ilceListe/{ilId} → mahalleListe/{ilceId}
            parsel/{mahalleId}/{adaNo}/{parselNo}
            parsel/{lat}/{lon}

   v18 değişiklikleri
   - Araç çubuğu tek satıra indi; İndir ve Araçlar artık düğmenin HEMEN ALTINDA açılan modern menüler
     (tek satır ölçüm paneli / favori listesi açıp çubuğu şişirmiyor).
   - Ölçüm sırasında harita üstünde küçük bir ölçüm kutusu var: anlık değer + Bitir/Sil.
   - Sağ bilgi bölmesi korunuyor: haritayı kapatmaz; küçük ekranda haritanın üstüne biner, kapatılabilir.
   - Koyu/açık tema, km/mil birimi, temel harita ve Çoklu seçimi Araçlar menüsünde.
   - Kopyala / Yazdır / Bağlantı kopyala yardımcıları İndir menüsünde.
   - Ölçüm katmanı değişkenleri "Temizle"den önce tanımlı; servis metinleri HTML kaçışlı.
*/
(function () {
  'use strict';

  var API = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/';
  function $(id) { return document.getElementById(id); }

  // ===================== PAYLAŞILAN DURUM =====================
  var cache = {};
  var state = { mahId: null, ada: null, parsel: null };
  var currentGeo = null;      // son çizilen parsel geojson
  var currentLookup = null;   // {type:'sa'|'coord'|'fav', p, ...}
  var lastBook = null;        // bilgi bölmesindeki bilgiler (kopyala/yazdır için)
  var marker = null;
  var toolMode = null, measurePts = [], measureLayer = null, wmsLayer = null;
  var activeImarKey = null;
  var UNIT = (localStorage.getItem('p360-unit') === 'mi') ? 'mi' : 'km';
  var lastW = 0, lastH = 0;

  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(n, d) {
    if (n === undefined || n === null || n === '') return '—';
    d = (d === undefined) ? 2 : d;
    var x = typeof n === 'number' ? n : parseFloat(String(n).replace(',', '.'));
    if (isNaN(x)) return String(n);
    return x.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function lenText(m) {
    var v = UNIT === 'mi' ? m / 1609.344 : m / 1000;
    return fmt(v, v < 10 ? 3 : 2) + ' ' + UNIT;
  }
  function areaText(m2) { return fmt(m2) + ' m²'; }

  // ===================== HARİTA + KATMANLAR =====================
  var map = L.map('map', {
    zoomControl: true, attributionControl: false,
    fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false
  }).setView([39.0, 35.3], 6);

  var googleSat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&hl=tr&gl=TR&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 21, maxNativeZoom: 20, attribution: 'Google' });
  var googleHyb = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&hl=tr&gl=TR&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 21, maxNativeZoom: 20 });
  var esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, attribution: 'Esri' });
  var esriLbl = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, opacity: 0.9 });
  var osmStreet = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, maxNativeZoom: 19, opacity: 0.55, attribution: '© OpenStreetMap' });
  var ALL = [googleSat, googleHyb, esriSat, esriLbl, osmStreet];
  function setBasemap(mode) {
    ALL.forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
    if (mode === 'hd') { googleSat.addTo(map); googleHyb.addTo(map); }
    else if (mode === 'sat') { esriSat.addTo(map); esriLbl.addTo(map); }
    else { osmStreet.setOpacity(1); osmStreet.addTo(map); }
    if (mode !== 'cadde') osmStreet.setOpacity(0.55);
  }
  setBasemap('hd');

  var layerMahalle = L.geoJSON(null, { style: { color: '#3d7bff', weight: 2, fill: false, dashArray: '5,4' } }).addTo(map);
  var layerParsel = L.geoJSON(null, { style: { color: '#2f9e6b', weight: 3, fillColor: '#2f9e6b', fillOpacity: 0.18 } }).addTo(map);
  var layerMulti = L.geoJSON(null, { style: { color: '#ffd43b', weight: 2, fillColor: '#ffd43b', fillOpacity: 0.10 } }).addTo(map);
  measureLayer = L.layerGroup().addTo(map);

  var elIl = $('il'), elIlce = $('ilce'), elMah = $('mah'),
      elAda = $('ada'), elParsel = $('parsel'),
      elLat = $('lat'), elLon = $('lon'),
      elInfo = $('info'), elSp = $('sp'), elMap = $('map'), elBar = $('bar'),
      elMeasureBox = $('measurebox'), elMeasureRead = $('measure-read');
  var infoInner = elInfo ? (elInfo.querySelector('.inner') || elInfo) : null;
  var HTML = document.documentElement;

  function busy(on, text) {
    if (elSp) elSp.style.display = on ? 'inline-block' : 'none';
    if (text !== undefined) show(text);
  }

  // ===================== AĞ =====================
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
        if (d && (d.features || d.type === 'Feature')) cache[path] = d;
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
      o.value = p.id; o.textContent = optText(p);
      sel.appendChild(o);
    });
    sel.disabled = items.length === 0;
    if (items.length && keepFirst) sel.selectedIndex = 1;
  }
  function fitGeom(geojson, pad) {
    try {
      var b = L.geoJSON(geojson).getBounds();
      if (b.isValid()) map.fitBounds(b.pad(pad === undefined ? 0.15 : pad), { animate: true });
    } catch (e) {}
  }
  function boundsOf(geojson) { try { return L.geoJSON(geojson).getBounds(); } catch (e) { return null; } }
  function centerOfCurrent() {
    if (!currentGeo) return null;
    try { var c = L.geoJSON(currentGeo).getBounds().getCenter(); return isFinite(c.lat) ? c : null; }
    catch (e) { return null; }
  }

  function syncMap() {
    if (!elMap || !map) return;
    var r = elMap.getBoundingClientRect();
    if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 2) return;
    lastW = r.width; lastH = r.height;
    map.invalidateSize();
  }
  window.addEventListener('resize', function () { syncMap(); });
  window.addEventListener('orientationchange', function () { setTimeout(syncMap, 250); });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { clearTimeout(window.__p360t); window.__p360t = setTimeout(syncMap, 80); });
    ro.observe(elMap); if (elBar) ro.observe(elBar);
  }

  // ===================== BİLGİ BÖLMESİ =====================
  function show(html) { if (infoInner) { infoInner.innerHTML = html; elInfo.scrollTop = 0; } }
  function head(t) {
    return '<div class="infohd"><span class="t">' + esc(t) + '</span>' +
      '<button id="btn-side-hide" class="sec x" title="Bölmeyi gizle">×</button></div>';
  }
  function bind() {
    var b = $('btn-side-hide');
    if (b) b.onclick = function () { setSide(false); };
  }
  function render(t, html) { show(head(t) + html); bind(); }
  function showMsg(html) { show(html); bind(); }
  function renderBook(t, rows, title2) {
    lastBook = { t: t, rows: rows };
    var html = '<div class="kv">';
    rows.forEach(function (r) {
      if (r[1] === undefined || r[1] === null || r[1] === '') return;
      html += '<span>' + esc(r[0]) + '</span><span><b>' + esc(r[1]) + '</b></span>';
    });
    html += '</div>';
    render(title2 || t, html);
  }

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

  // ===================== TEMA =====================
  function setTheme(dark, noStore) {
    HTML.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (!noStore) { try { localStorage.setItem('p360-theme', dark ? 'dark' : 'light'); } catch (e) {} }
    var s = $('dark-on');
    if (s) s.checked = !!dark;
  }
  setTheme(localStorage.getItem('p360-theme') !== 'light', true);

  // ===================== MENÜLER =====================
  var pops = ['dlpop', 'toolpop', 'li-menu', 'more-box'];
  function closePops(except) {
    pops.forEach(function (id) { var p = $(id); if (p && id !== except) p.classList.remove('on'); });
  }
  function togglePop(id) {
    var p = $(id);
    if (!p) return;
    var was = p.classList.contains('on');
    closePops();
    if (!was) p.classList.add('on');
  }
  $('btn-dl').onclick = function (e) { e.stopPropagation(); togglePop('dlpop'); };
  $('btn-tools').onclick = function (e) { e.stopPropagation(); togglePop('toolpop'); renderFavs(); };
  $('btn-more').onclick = function (e) { e.stopPropagation(); togglePop('li-menu'); };
  $('btn-more2').onclick = function (e) { e.stopPropagation(); togglePop('more-box'); };
  document.addEventListener('click', function () { closePops(); });
  pops.forEach(function (id) {
    var p = $(id);
    if (p) p.addEventListener('click', function (e) { e.stopPropagation(); });
  });

  // Araçlar / ⋯ menülerindeki ortak eylemler
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act],[data-base],[data-fmt]');
    if (!b) return;
    if (b.hasAttribute('data-base')) {
      setBasemap(b.getAttribute('data-base'));
      var sel = $('base'); if (sel) sel.value = b.getAttribute('data-base');
      var all = document.querySelectorAll('[data-base]');
      Array.prototype.forEach.call(all, function (x) { x.classList.toggle('on', x === b); });
      closePops();
      return;
    }
    var act = b.getAttribute('data-act');
    if (act) {
      if (act === 'measure') { closePops(); startMeasure(); }
      else if (act === 'unit') { setUnit(UNIT === 'km' ? 'mi' : 'km'); }
      else if (act === 'google') { openGoogle(); closePops(); }
      else if (act === 'street') { openStreet(); closePops(); }
      else if (act === 'tkgm') { window.open('https://parselsorgu.tkgm.gov.tr/', '_blank'); closePops(); }
      else if (act === 'clear') { closePops(); $('btn-clear').click(); }
      else if (act === 'other') { closePops(); togglePop('more-box'); }
      else if (act === 'csv') { copyInfo(); }
      else if (act === 'print') { window.print(); }
      else if (act === 'link') { copyLink(); }
      return;
    }
  });
  

  // ===================== BİRİM =====================
  function setUnit(u) {
    UNIT = u === 'mi' ? 'mi' : 'km';
    try { localStorage.setItem('p360-unit', UNIT); } catch (e) {}
    var l1 = $('unit-lbl'); if (l1) l1.textContent = UNIT;
    Array.prototype.forEach.call(document.querySelectorAll('.unit-lbl'), function (x) { x.textContent = UNIT; });
    refreshMeasure();
  }
  setUnit(UNIT);

  // ===================== İDARİ ZİNCİR =====================
  function loadIl() {
    busy(true, head('Parsel bilgisi') + '<div class="msg">İller yükleniyor…</div>');
    bind();
    req('idariYapi/ilListe', function (err, d) {
      busy(false);
      if (err) { showMsg(head('Parsel bilgisi') + '<div class="err">İl listesi alınamadı: ' + esc(err) + '</div>'); bind(); return; }
      fill(elIl, d.features || [], 'İl…');
      showMsg(head('Parsel bilgisi') + '<div class="ok">81 il yüklendi. İl seç.</div>'); bind();
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

    busy(true, head('Parsel bilgisi') + '<div class="msg">İlçeler yükleniyor…</div>'); bind();
    req('idariYapi/ilceListe/' + id, function (err, d) {
      busy(false);
      if (err) { showMsg(head('Parsel bilgisi') + '<div class="err">İlçe listesi alınamadı: ' + esc(err) + '</div>'); bind(); return; }
      fill(elIlce, d.features || [], 'İlçe…');
      showMsg(head('Parsel bilgisi') + '<div class="ok"><b>' + esc(selectedName) + '</b> — ' + (d.features || []).length + ' ilçe. İlçe seç.</div>'); bind();
    });
  });

  elIlce.addEventListener('change', function () {
    var id = elIlce.value;
    fill(elMah, [], 'Mahalle…');
    layerParsel.clearLayers(); elAda.value = ''; elParsel.value = '';
    if (!id) return;
    busy(true, head('Parsel bilgisi') + '<div class="msg">Mahalleler yükleniyor…</div>'); bind();
    req('idariYapi/mahalleListe/' + id, function (err, d) {
      busy(false);
      if (err) { showMsg(head('Parsel bilgisi') + '<div class="err">Mahalle listesi alınamadı: ' + esc(err) + '</div>'); bind(); return; }
      fill(elMah, d.features || [], 'Mahalle…');
      var nm = elIlce.selectedOptions[0] ? elIlce.selectedOptions[0].textContent : '';
      showMsg(head('Parsel bilgisi') + '<div class="ok"><b>' + esc(nm) + '</b> — ' + (d.features || []).length + ' mahalle. Mahalle seç, sonra ada/parsel gir.</div>'); bind();
      var f = (d.features || [])[0];
      if (f && f.geometry) fitGeom(f, 0.25);
    });
  });

  elMah.addEventListener('change', function () {
    var id = elMah.value;
    layerParsel.clearLayers(); elAda.value = ''; elParsel.value = '';
    if (!id) return;
    busy(true, head('Parsel bilgisi') + '<div class="msg">Mahalle sınırı getiriliyor…</div>'); bind();
    req('idariYapi/mahalleListe/' + elIlce.value, function (err, d) {
      busy(false);
      if (err || !d) { showMsg(head('Parsel bilgisi') + '<div class="err">Mahalle sınırı alınamadı: ' + esc(err || '') + '</div>'); bind(); return; }
      var f = (d.features || []).filter(function (x) { return String(x.properties.id) === String(id); })[0];
      var name = elMah.selectedOptions[0] ? elMah.selectedOptions[0].textContent : '';
      if (!f) { showMsg(head('Parsel bilgisi') + '<div class="err">Mahalle sınırı bulunamadı.</div>'); bind(); return; }
      layerMahalle.clearLayers(); layerMahalle.addData(f); fitGeom(f, 0.12);
      var b = boundsOf(f), c = b ? b.getCenter() : null;
      showMsg(head('Mahalle') + '<div class="ok"><b>' + esc(name) + '</b> mahallesi haritada.</div>' +
        '<div class="hint">Şimdi Ada ve Parsel girip Sorgula\'ya bas. Merkez: ' +
        (c ? (c.lat.toFixed(5) + ', ' + c.lng.toFixed(5)) : '—') + '</div>'); bind();
      if (c) { elLat.value = c.lat.toFixed(6); elLon.value = c.lng.toFixed(6); }
    });
  });

  // ===================== PARSEL =====================
  function idOf(p, lookup) {
    if (p && p.id !== undefined && p.id !== null && p.id !== '') return String(p.id).split('_')[0];
    if (lookup && lookup.mahId) return lookup.mahId;
    if (state.mahId) return state.mahId;
    return null;
  }
  function lookupUrl(lookup, fmtq) {
    if (!lookup) return null;
    var p = lookup.p || {}, mh = null;
    if (lookup.type === 'coord' || lookup.type === 'fav') {
      mh = idOf(p, lookup);
      if (!mh) return null;
      return fmtq ? API + 'parsel/download/' + mh + '/' + fmtq : null;
    }
    mh = (p.mahalleId !== undefined && p.mahalleId !== null && p.mahalleId !== '') ? p.mahalleId : lookup.mahId;
    if ((mh === undefined || mh === null || mh === '') && p.id) mh = String(p.id).split('_')[0];
    if (mh === undefined || mh === null || mh === '') return null;
    return fmtq ? API + 'parsel/download/' + mh + '/' + lookup.ada + '/' + lookup.parsel + '/' + fmtq
                : API + 'parsel/' + mh + '/' + lookup.ada + '/' + lookup.parsel;
  }

  function drawParsel(geojson, source) {
    if (!geojson || (!geojson.geometry && !geojson.properties)) {
      render('Parsel bilgisi', '<div class="err">Parsel bulunamadı.</div>'); return;
    }
    currentGeo = geojson;
    if ($('multi') && $('multi').checked && geojson.geometry) layerMulti.addData(geojson);
    else {
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
    html += '<div class="dltabs">' +
      '<button class="sec" data-act="csv" style="grid-column:1/-1">Bilgileri kopyala</button>' +
      '<button class="sec" data-act="link">Bağlantıyı kopyala</button>' +
      '<button class="sec" data-act="print">Yazdır / PDF</button></div>';

    lastBook = { t: 'Parsel bilgisi', rows: rows };
    render('Parsel bilgisi', html);
  }

  function sorgula() {
    var mahId = elMah.value, ada = elAda.value.trim(), parsel = elParsel.value.trim();
    if (!mahId) { render('Parsel bilgisi', '<div class="err">Önce mahalle seç.</div>'); return; }
    if (!ada || !parsel) { render('Parsel bilgisi', '<div class="err">Ada ve parsel numarasını gir (ör. 1559 / 883).</div>'); return; }

    var path = 'parsel/' + mahId + '/' + ada + '/' + parsel;
    busy(true, head('Parsel bilgisi') + '<div class="msg">Parsel sorgulanıyor… ' + esc(ada + '/' + parsel) + '</div>'); bind();
    req(path, function (err, d) {
      busy(false);
      if (err || !d) {
        render('Parsel bilgisi', '<div class="err"><b>' + esc(ada) + '/' + esc(parsel) + '</b> bulunamadı.<br><span class="hint">' + esc(err || 'Kayıt yok') + '</span></div>');
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

  // ===================== KOORDİNAT =====================
  function koordSor() {
    var la = parseFloat(String(elLat.value).replace(',', '.')),
        lo = parseFloat(String(elLon.value).replace(',', '.'));
    if (isNaN(la) || isNaN(lo)) { render('Parsel bilgisi', '<div class="err">Geçerli enlem/boylam gir.</div>'); return; }
    if (la < 35 || la > 43 || lo < 25 || lo > 46) { render('Parsel bilgisi', '<div class="err">Koordinat Türkiye sınırları dışında (enlem 35-43, boylam 25-46).</div>'); return; }

    busy(true, head('Parsel bilgisi') + '<div class="msg">Koordinat sorgulanıyor…</div>'); bind();
    req('parsel/' + la + '/' + lo, function (err, d) {
      busy(false);
      if (err || !d) { render('Parsel bilgisi', '<div class="err">Bu noktada parsel yok.<br><span class="hint">' + esc(err || '') + '</span></div>'); return; }
      layerMahalle.clearLayers();
      if (marker) map.removeLayer(marker);
      marker = L.circleMarker([la, lo], { radius: 6, color: '#d9822b', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map);
      currentLookup = { type: 'coord', lat: la, lon: lo, p: d.properties || {} };
      drawParsel(d, 'parsel/' + la + '/' + lo);
    });
  }
  $('btn-coord').addEventListener('click', koordSor);
  elLon.addEventListener('keydown', function (e) { if (e.key === 'Enter') koordSor(); });

  // ===================== SEKMELER =====================
  function tab(which) {
    ['adm', 'coord', 'imar'].forEach(function (k) {
      var pane = $('pane-' + k);
      if (pane) pane.classList.toggle('on', k === which);
      var b = $('tb-' + k);
      if (b) b.className = (k === which) ? 'on' : 'sec';
    });
    setTimeout(syncMap, 60);
  }
  $('tb-adm').onclick = function () { tab('adm'); };
  $('tb-coord').onclick = function () { tab('coord'); };
  $('tb-imar').onclick = function () { tab('imar'); };

  // ===================== İNDİRME =====================
  Array.prototype.forEach.call(document.querySelectorAll('#dlpop [data-fmt]'), function (b) {
    b.addEventListener('click', function () { indir(b.getAttribute('data-fmt')); closePops(); });
  });
  function indir(fmtq) {
    var u = lookupUrl(currentLookup, fmtq);
    if (!u) { render('İndirme', '<div class="err">İndirmek için ada/parsel sorgula ya da haritadan bir parsel seç.</div>'); return; }
    render('İndirme', '<div class="ok">Hazır: <b>' + esc(String(fmtq).toUpperCase()) + '</b></div>' +
      '<div class="coords" style="margin-top:6px">' + esc(u) + '</div>' +
      '<div class="hint" style="margin-top:6px">Açılmazsa <a href="' + esc(u) + '" target="_blank" rel="noopener">buraya dokun</a>.</div>');
    window.open(u, '_blank');
  }
  function copyInfo() {
    if (!lastBook) { render('Kopyala', '<div class="err">Önce bir parsel sorgula.</div>'); return; }
    var txt = lastBook.rows.filter(function (r) { return r[1] !== undefined && r[1] !== null && r[1] !== ''; })
      .map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');
    writeClip(txt, 'Parsel bilgisi kopyalandı.');
  }
  function copyLink() {
    var h = (typeof location !== 'undefined') ? location.href : '';
    writeClip(h, 'Bağlantı kopyalandı.');
  }
  function writeClip(txt, okMsg) {
    var done = function () { render('Kopyala', '<div class="ok">' + esc(okMsg) + '</div><div class="coords" style="margin-top:6px">' + esc(txt) + '</div>'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { render('Kopyala', '<div class="err">Kopyalanamadı.</div>'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { render('Kopyala', '<div class="err">Kopyalanamadı.</div>'); }
      document.body.removeChild(ta);
    }
  }

  // ===================== TEMİZLE =====================
  $('btn-clear').onclick = function () {
    layerMahalle.clearLayers(); layerParsel.clearLayers(); layerMulti.clearLayers();
    measureLayer.clearLayers(); measurePts = []; toolMode = null; refreshMeasure();
    currentGeo = null; currentLookup = null; lastBook = null;
    if (marker) { map.removeLayer(marker); marker = null; }
    elIl.value = ''; fill(elIlce, [], 'İlçe…'); fill(elMah, [], 'Mahalle…');
    elAda.value = ''; elParsel.value = '';
    state = { mahId: null, ada: null, parsel: null };
    setAutoImar(null);
    map.setView([39.0, 35.3], 6);
    setHash({});
    render('Parsel bilgisi', '<div class="ok">Temizlendi.</div>');
  };

  // ===================== FAVORİLER =====================
  var FAV_KEY = 'kadastro-favoriler';
  function readFavs() { try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; } }
  function writeFavs(arr) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); }
    catch (e) { render('Favoriler', '<div class="err">Favoriler kaydedilemedi (depolama dolu olabilir).</div>'); }
  }
  function renderFavs() {
    var box = $('favbox'), arr = readFavs();
    if (!box) return;
    box.innerHTML = arr.length ? arr.map(function (x, i) {
      return '<div class="favrow"><span><b>' + esc(x.ozet) + '</b> <span class="hint">' + esc(x.alan || '') + ' m²</span></span>' +
        '<span><button class="sec" data-fi="' + i + '">Göster</button> <button class="sec" data-fd="' + i + '">Sil</button></span></div>';
    }).join('') : '<span class="hint">Favori yok.</span>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-fi]'), function (b) {
      b.onclick = function () {
        var x = arr[+b.dataset.fi];
        if (x && x.geo) { currentLookup = { type: 'fav', p: x.geo.properties || {} }; drawParsel(x.geo, 'favori'); closePops(); }
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-fd]'), function (b) {
      b.onclick = function () { arr.splice(+b.dataset.fd, 1); writeFavs(arr); renderFavs(); };
    });
  }
  $('btn-fav').onclick = function () {
    if (!currentGeo) { render('Favoriler', '<div class="err">Önce bir parsel sorgula.</div>'); return; }
    var arr = readFavs(), p = currentGeo.properties || {};
    if (!arr.some(function (x) { return x.ozet === p.ozet; })) arr.push({ ozet: p.ozet, alan: p.alan, geo: currentGeo });
    writeFavs(arr); renderFavs();
    render('Favoriler', '<div class="ok">' + esc(p.ozet || 'Parsel') + ' favorilere eklendi.</div>' +
      '<div class="hint" style="margin-top:6px">Araçlar ▾ → Favoriler listesinden geri çağırabilirsin.</div>');
  };
  var multiEl = $('multi');
  if (multiEl) multiEl.onchange = function () { if (!this.checked) layerMulti.clearLayers(); };
  var darkEl = $('dark-on');
  if (darkEl) darkEl.onchange = function () { setTheme(this.checked); };

  $('btn-help').onclick = function () {
    render('Nasıl kullanılır', '<div class="kv">' +
      '<span>Ada/parsel</span><span><b>İdari</b> → İl → İlçe → Mahalle → Ada + Parsel → <b>Sorgula</b></span>' +
      '<span>Haritadan</span><span>Haritaya dokun: noktanın parseli sağda açılır.</span>' +
      '<span>Ölçüm</span><span><b>Araçlar ▾</b> → Mesafe/Alan ölç; haritanın sol üstündeki kutudan bitir.</span>' +
      '<span>İndirme</span><span><b>İndir ▾</b> → KML · GeoJSON · DXF · SHP; ayrıca kopyala / yazdır / bağlantı.</span>' +
      '<span>Favori</span><span><b>☆ Favori</b> ile sakla, <b>Araçlar ▾</b> içinden çağır.</span>' +
      '<span>e-İmar</span><span>Yetkili belediyelerin portalı; bazı illerde imar katmanı haritaya bindirilir.</span>' +
      '<span>Bölme</span><span>Sağ bölmeyi <b>×</b> ile gizle, haritanın köşesindeki <b>▸/◂</b> ile geri getir.</span>' +
      '</div>');
  };

  // ===================== GPS =====================
  var hasGeo = !!(navigator.geolocation && (window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost'));
  if (hasGeo) {
    $('btn-gps').onclick = function () {
      busy(true, head('Parsel bilgisi') + '<div class="msg">GPS konumu alınıyor…</div>'); bind();
      navigator.geolocation.getCurrentPosition(function (p) {
        elLat.value = p.coords.latitude.toFixed(7); elLon.value = p.coords.longitude.toFixed(7);
        busy(false); tab('coord'); koordSor();
      }, function (e) {
        busy(false);
        if (e.code === 1) {
          render('Konum izni', '<div class="err"><b>Konum izni reddedildi.</b></div>' +
            '<div class="hint" style="line-height:1.7">Safari’de adres çubuğundaki <b>Sayfa Menüsü (aA)</b> → <b>Web Sitesi Ayarları</b> → <b>Konum</b> → <b>İzin Ver</b>.<br>' +
            'Olmazsa: iPhone <b>Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri → Safari Web Siteleri</b>.</div>' +
            '<button id="gps-retry" style="margin-top:8px">GPS’yi Tekrar Dene</button>');
          setTimeout(function () { var r = $('gps-retry'); if (r) r.onclick = function () { $('btn-gps').click(); }; }, 0);
        } else if (e.code === 2) render('Parsel bilgisi', '<div class="err">Konum belirlenemedi. GPS/Wi-Fi açık olmalı.</div>');
        else if (e.code === 3) render('Parsel bilgisi', '<div class="err">Konum isteği zaman aşımına uğradı. Tekrar dene.</div>');
        else render('Parsel bilgisi', '<div class="err">Konum alınamadı: ' + esc(e.message) + '</div>');
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    };
  } else {
    $('btn-gps').style.display = 'none';
    Array.prototype.forEach.call(document.querySelectorAll('[data-act="gps"]'), function (b) { b.style.display = 'none'; });
  }

  // ===================== ÖLÇÜM =====================
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
  function measureValue() {
    var typ = $('measure-type').value;
    if (typ === 'area') return { txt: areaText(polyArea(measurePts)), n: measurePts.length };
    var d = 0;
    for (var i = 1; i < measurePts.length; i++) d += hav(measurePts[i - 1], measurePts[i]);
    return { txt: lenText(d), n: measurePts.length };
  }
  function refreshMeasure() {
    if (!measureLayer) return;
    measureLayer.clearLayers();
    if (!measurePts.length) { if (elMeasureRead) elMeasureRead.textContent = '0'; return; }
    var typ = $('measure-type').value;
    if (typ === 'area' && measurePts.length > 2) L.polygon(measurePts, { color: '#ff5c8a', fillOpacity: .15 }).addTo(measureLayer);
    else L.polyline(measurePts, { color: '#ff5c8a', weight: 3 }).addTo(measureLayer);
    measurePts.forEach(function (p) {
      L.circleMarker(p, { radius: 4, color: '#fff', fillColor: '#ff5c8a', fillOpacity: 1 }).addTo(measureLayer);
    });
    var v = measureValue();
    if (elMeasureRead) elMeasureRead.textContent = v.txt + ' · ' + v.n + ' nokta';
  }
  function startMeasure() {
    toolMode = 'measure'; measurePts = [];
    if (elMeasureBox) elMeasureBox.classList.add('on');
    refreshMeasure();
    render('Ölçüm', '<div class="ok">Haritada noktaları işaretle. Değer haritanın sol üstünde; <b>Bitir</b> ile sabitlenir.</div>');
  }
  $('btn-measure').onclick = startMeasure;
  $('measure-type').onchange = refreshMeasure;
  $('btn-measure-clear').onclick = function () {
    toolMode = null; measurePts = []; refreshMeasure();
    if (elMeasureBox) elMeasureBox.classList.remove('on');
    render('Ölçüm', '<div class="ok">Ölçüm temizlendi.</div>');
  };
  $('btn-measure-finish').onclick = function () {
    var v = measureValue(), typ = $('measure-type').value;
    if (!measurePts.length) { render('Ölçüm', '<div class="err">Önce haritada nokta işaretle.</div>'); return; }
    toolMode = null;
    if (elMeasureBox) elMeasureBox.classList.remove('on');
    renderBook('Ölçüm', [
      ['Tür', typ === 'area' ? 'Alan' : 'Mesafe'],
      ['Nokta', String(measurePts.length)],
      [typ === 'area' ? 'Alan' : 'Mesafe', v.txt],
      ['Kapalı alan (m²)', typ === 'area' ? fmt(polyArea(measurePts)) : '—']
    ], 'Ölçüm sonucu');
  };

  // ===================== AÇIK İMAR KATMANLARI =====================
  var IMAR_LAYERS = {
    ankara: {
      title: 'Ankara 1/1000 Uygulama İmar Planı',
      url: 'https://baskentcbs.ankara.bel.tr/server/services/plan/UIP_Goruntuleme/MapServer/WMSServer',
      layers: '1,2,3,4,5,6,7,8,9,10,12,13,14,16,17,18,19',
      version: '1.3.0'
    }
  };
  function setAutoImar(key) {
    if (wmsLayer) { map.removeLayer(wmsLayer); wmsLayer = null; }
    activeImarKey = (key && IMAR_LAYERS[key]) ? key : null;
    var b = $('btn-auto-imar');
    if (!b) return;
    if (!activeImarKey) {
      b.disabled = true; b.textContent = 'İmar katmanı yok'; b.style.background = '';
      return;
    }
    var cfg = IMAR_LAYERS[activeImarKey];
    wmsLayer = L.tileLayer.wms(cfg.url, { layers: cfg.layers, format: 'image/png', transparent: true, opacity: .68, version: cfg.version }).addTo(map);
    b.disabled = false; b.textContent = '✓ İmar katmanı'; b.style.background = '#168f55';
  }
  $('btn-auto-imar').onclick = function () {
    if (!activeImarKey) return;
    if (wmsLayer && map.hasLayer(wmsLayer)) { map.removeLayer(wmsLayer); this.textContent = 'İmar katmanı aç'; this.style.background = ''; }
    else setAutoImar(activeImarKey);
  };
  $('btn-wms-clear').onclick = function () {
    if (wmsLayer) { map.removeLayer(wmsLayer); wmsLayer = null; }
    $('btn-auto-imar').textContent = activeImarKey ? 'İmar katmanını aç' : 'İmar katmanı yok';
    $('btn-auto-imar').style.background = '';
    render('İmar katmanı', '<div class="ok">İmar katmanı kapatıldı.</div>');
  };

  function openGoogle() {
    var c = centerOfCurrent() || map.getCenter();
    window.open('https://www.google.com/maps/search/?api=1&query=' + c.lat + ',' + c.lng, '_blank');
  }
  function openStreet() {
    var c = centerOfCurrent();
    if (!c) { render('Street View', '<div class="err">Street View için önce bir parsel sorgula.</div>'); return; }
    window.open('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + c.lat + ',' + c.lng, '_blank');
  }

  // ===================== e-İMAR PORTALLARI =====================
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
    if (!k) { ilceSel.innerHTML = '<option value="">İlçe…</option>'; render('e-İmar', '<div class="err">e-imar için il seç.</div>'); return; }
    var it = IMAR[k];
    req('idariYapi/ilListe', function (err, d) {
      var il = !err && d && (d.features || []).filter(function (f) { return imarKey(f.properties.text) === k; })[0];
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
    render('e-İmar', '<div class="ok"><b>' + esc(it.ad) + '</b></div>' +
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
      render('e-İmar', '<div class="ok"><b>' + esc(ilce.textContent) + '</b> e-İmar bağlantısı hazır.</div>' +
        '<div class="kv"><span>Portal</span><span><b>' + esc(ozel ? 'İlçe Belediyesi KEOS' : IMAR[k].ad) + '</b></span>' +
        '<span>Adres</span><span class="coords">' + esc(u) + '</span></div>' +
        (activeImarKey ? '<div class="ok">✓ Açık imar katmanı haritada gösteriliyor.</div>'
                       : '<div class="hint">Bu ilçe için açık WMS bulunamadı; resmî portala yönlendirilir.</div>'));
    }
  });
  $('btn-imar').addEventListener('click', function () {
    var u = selectedImarUrl();
    if (!u) { render('e-İmar', '<div class="err">e-imar için il ve ilçe seç.</div>'); return; }
    window.open(u, '_blank');
  });

  // ===================== HARİTA TIKLAMA =====================
  map.on('click', function (e) {
    if (toolMode === 'measure') { measurePts.push(e.latlng); refreshMeasure(); return; }
    elLat.value = e.latlng.lat.toFixed(6);
    elLon.value = e.latlng.lng.toFixed(6);
    tab('coord');
    koordSor();
  });

  // ===================== ADRES ÇUBUĞU =====================
  function readHash() { try { return new URLSearchParams(location.hash.replace(/^#/, '')); } catch (e) { return null; } }
  function setHash(params) {
    var s = Object.keys(params).filter(function (k) { return params[k]; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    try { history.replaceState(null, '', s ? '#' + s : location.pathname + location.search); } catch (e) {}
  }

  // ===================== BAŞLAT =====================
  setTimeout(function () { var s = $('splash'); if (s) s.classList.add('hide'); }, 900);
  setTimeout(function () { var s = $('splash'); if (s) s.style.display = 'none'; }, 1550);
  window.addEventListener('load', function () { syncMap(); setTimeout(syncMap, 200); });

  setSide(sideOpen, true);
  loadIl();
  setTimeout(function () { setBasemap('hd'); var sel = $('base'); if (sel) sel.value = 'hd'; syncMap(); }, 250);

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