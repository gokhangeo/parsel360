/* TKGM Parsel Sorgu — tek dosya mantığı
   Canlı servis: https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/
   Zincir:  idariYapi/ilListe
            idariYapi/ilceListe/{ilId}
            idariYapi/mahalleListe/{ilceId}
            parsel/{mahalleId}/{adaNo}/{parselNo}
            parsel/{lat}/{lon}
*/
(function () {
  'use strict';

  var API = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/';

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };
  var elIl = $('il'), elIlce = $('ilce'), elMah = $('mah'),
      elAda = $('ada'), elParsel = $('parsel'),
      elLat = $('lat'), elLon = $('lon'),
      elInfo = $('info'), elSp = $('sp');

  // ---- Harita ----
  var map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  }).setView([39.0, 35.3], 6);

  // ---- Altlıklar ----
  // Google HD uydu (z20'ye kadar gerçek veri) — referer kısıtı yok
  var googleSat = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=s&hl=tr&gl=TR&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 21, maxNativeZoom: 20, attribution: 'Google' }
  );
  // Google melez (uydu + yol/isim çizgileri) — HDLI
  var googleHyb = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=y&hl=tr&gl=TR&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 21, maxNativeZoom: 20 }
  );
  // Esri uydu (yedek / sınır etiketleri)
  var esriSat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, attribution: 'Esri' }
  );
  var esriLbl = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, opacity: 0.9 }
  );
  // OSM — cadde/sokak isimleri net görünür (şeffaf etiket katmanı gibi kullanılır)
  var osmStreet = L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, maxNativeZoom: 19, opacity: 0.55, attribution: '© OpenStreetMap' }
  );

  var ALL = [googleSat, googleHyb, esriSat, esriLbl, osmStreet];
  function clearBase() { ALL.forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); }); }

  function setBasemap(mode) {
    clearBase();
    if (mode === 'hd') { googleSat.addTo(map); googleHyb.addTo(map); }        // HD uydu + cadde çizgileri
    else if (mode === 'sat') { esriSat.addTo(map); esriLbl.addTo(map); }
    else if (mode === 'cadde') { osmStreet.setOpacity(1); osmStreet.addTo(map); }
  }
  setBasemap('hd');

  $('base').addEventListener('change', function (e) {
    if (e.target.value === 'cadde') { osmStreet.setOpacity(1); } else { osmStreet.setOpacity(0.55); }
    setBasemap(e.target.value);
  });

  // OSM cadde isimleri yoğunluk ayarı 'base' menüsünden yönetilir.

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
  var currentGeo = null;

  var marker = null;

  // ---- yardımcılar ----
  var cache = {};
  var state = { mahId: null, ada: null, parsel: null };

  function fmt(n, d) {
    if (n === undefined || n === null || n === '') return '—';
    d = (d === undefined) ? 2 : d;
    var x = typeof n === 'number' ? n : parseFloat(String(n).replace(',', '.'));
    if (isNaN(x)) return String(n);
    return x.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function busy(on, text) {
    elSp.style.display = on ? 'inline-block' : 'none';
    if (text !== undefined) show(text);
  }

  function show(html) { elInfo.innerHTML = html; }
  function msg(t, cls) { show('<div class="' + (cls || 'msg') + '">' + t + '</div>'); }

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

  function optText(p) { return p && (p.text || p.ilAd || p.ilceAd || p.mahalleAd) ? (p.text || p.ilAd || p.ilceAd || p.mahalleAd) : String(p && p.id); }

  function fill(sel, items, placeholder, keepFirst) {
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
      var l = L.geoJSON(geojson);
      var b = l.getBounds();
      if (b.isValid()) map.fitBounds(b.pad(pad || 0.15), { animate: true });
    } catch (e) {}
  }

  function boundsOf(geojson) {
    try { return L.geoJSON(geojson).getBounds(); } catch (e) { return null; }
  }

  // ---- il / ilçe / mahalle ----
  function loadIl() {
    busy(true, 'İller yükleniyor…');
    req('idariYapi/ilListe', function (err, d) {
      busy(false);
      if (err) { msg('İl listesi alınamadı: ' + err, 'err'); return; }
      fill(elIl, d.features || [], 'İl…');
      msg('81 il yüklendi. İl seç.', 'ok');
    });
  }

  elIl.addEventListener('change', function () {
    var id = elIl.value;
    var selectedName = elIl.selectedOptions[0] ? elIl.selectedOptions[0].textContent : '';
    setAutoImar(imarKey(selectedName));
    fill(elIlce, [], 'İlçe…'); fill(elMah, [], 'Mahalle…');
    layerMahalle.clearLayers(); layerParsel.clearLayers();
    elAda.value = ''; elParsel.value = '';
    if (!id) return;

    var ilGeom = null;
    var sel = elIl.selectedOptions[0];
    // il sınırı haritada zaten önbellekte olabilir
    req('idariYapi/ilListe', function (e, d) {
      if (d) {
        var f = (d.features || []).filter(function (x) { return String(x.properties.id) === String(id); })[0];
        if (f) { layerMahalle.clearLayers(); fitGeom(f, 0.25); }
      }
    });

    busy(true, 'İlçeler yükleniyor…');
    req('idariYapi/ilceListe/' + id, function (err, d) {
      busy(false);
      if (err) { msg('İlçe listesi alınamadı: ' + err, 'err'); return; }
      fill(elIlce, d.features || [], 'İlçe…');
      msg('<b>' + sel.textContent + '</b> — ' + (d.features || []).length + ' ilçe. İlçe seç.', 'ok');
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
      if (err) { msg('Mahalle listesi alınamadı: ' + err, 'err'); return; }
      fill(elMah, d.features || [], 'Mahalle…');
      msg('<b>' + elIlce.selectedOptions[0].textContent + '</b> — ' + (d.features || []).length + ' mahalle. Mahalle seç, sonra ada/parsel gir.', 'ok');
    });

    // ilçe sınırına yakınlaş
    var sel = elIlce.selectedOptions[0];
    req('idariYapi/ilListe', function () {});
  });

  elMah.addEventListener('change', function () {
    var id = elMah.value;
    layerParsel.clearLayers(); elAda.value = ''; elParsel.value = '';
    if (!id) return;

    busy(true, 'Mahalle sınırı getiriliyor…');
    // mahalle sınırı: ilceListe yerine mahalle geometrisi ilceId ile gelir
    req('idariYapi/mahalleListe/' + elIlce.value, function (err, d) {
      busy(false);
      if (err || !d) { msg('Mahalle sınırı alınamadı: ' + (err || ''), 'err'); return; }
      var f = (d.features || []).filter(function (x) { return String(x.properties.id) === String(id); })[0];
      var name = elMah.selectedOptions[0].textContent;
      if (f) {
        layerMahalle.clearLayers();
        layerMahalle.addData(f);
        fitGeom(f, 0.12);
        var b = boundsOf(f);
        var c = b ? b.getCenter() : null;
        show('<div class="ok"><b>' + name + '</b> mahallesi haritada.</div>' +
             '<div class="hint">Şimdi <b>Ada</b> ve <b>Parsel</b> girip Sorgula\'ya bas. ' +
             'Merkez: ' + (c ? (c.lat.toFixed(5) + ', ' + c.lng.toFixed(5)) : '—') + '</div>');
        elLat.value = c ? c.lat.toFixed(6) : elLat.value;
        elLon.value = c ? c.lng.toFixed(6) : elLon.value;
      } else {
        msg('Mahalle sınırı bulunamadı.', 'err');
      }
    });
  });

  // ---- parsel sorgu (ada/parsel) ----
  function drawParsel(geojson, source) {
    currentGeo = geojson;
    if ($('multi').checked) {
      layerMulti.addData(geojson);
    } else {
      layerParsel.clearLayers();
      layerParsel.addData(geojson);
    }
    fitGeom(geojson, 0.35);

    var p = geojson.properties || {};
    // indirme için durumu kaydet
    state.mahId = p.mahalleId || state.mahId;
    state.ada = p.adaNo || state.ada;
    state.parsel = p.parselNo || state.parsel;
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
    var html = '<div class="ok">Parsel bulundu — <span class="hint">' + source + '</span></div><div class="kv">';
    rows.forEach(function (r) {
      if (r[1] === undefined || r[1] === null || r[1] === '') return;
      html += '<span>' + r[0] + '</span><span><b>' + r[1] + '</b></span>';
    });
    html += '</div>';

    if (geojson.geometry && geojson.geometry.coordinates) {
      var flat = [];
      (function walk(a) {
        if (typeof a[0] === 'number') flat.push(a);
        else a.forEach(walk);
      })(geojson.geometry.coordinates);
      html += '<div class="coords" style="margin-top:6px">' +
              flat.length + ' nokta • ilk: ' + flat[0].map(function (x) { return x.toFixed(6); }).join(', ') +
              '</div>';
    }
    show(html);
  }

  function sorgula() {
    var mahId = elMah.value, ada = elAda.value.trim(), parsel = elParsel.value.trim();
    if (!mahId) { msg('Önce mahalle seç.', 'err'); return; }
    if (!ada || !parsel) { msg('Ada ve parsel numarasını gir (ör. 1559 / 883).', 'err'); return; }

    var path = 'parsel/' + mahId + '/' + ada + '/' + parsel;
    busy(true, 'Parsel sorgulanıyor… ' + ada + '/' + parsel);
    req(path, function (err, d) {
      busy(false);
      if (err) { msg('<b>' + ada + '/' + parsel + '</b> bulunamadı.<br><span class="hint">' + err + '</span>', 'err'); return; }
      drawParsel(d, 'parsel/' + mahId + '/' + ada + '/' + parsel);
    });
  }

  $('btn-sorgu').addEventListener('click', sorgula);
  elAda.addEventListener('keydown', function (e) { if (e.key === 'Enter') elParsel.focus(); });
  elParsel.addEventListener('keydown', function (e) { if (e.key === 'Enter') sorgula(); });

  // ---- ada listele: adadaki tüm parselleri tara ----
  var layerAda = L.geoJSON(null, {
    style: { color: '#d9822b', weight: 2, fillColor: '#d9822b', fillOpacity: 0.12 }
  }).addTo(map);

  function adaListele() {
    var mah = elMah.value, ada = elAda.value.trim();
    if (!mah) { msg('Önce mahalle seç.', 'err'); return; }
    if (!ada) { msg('Ada numarasını gir.', 'err'); return; }

    layerAda.clearLayers();
    var limit = parseInt($('ada-limit').value || '250', 10); // kullanıcı seçimi
    var found = [];
    var done = 0, idx = 0, active = 0, MAXP = 6;   // eşzamanlı istek
    var bar = '<div class="hint">Ada <b>' + ada + '</b> taranıyor… <span id="pcount">0</span> parsel</div>';

    busy(true, bar);

    function next() {
      while (active < MAXP && idx < limit) {
        idx++; active++;
        (function (n) {
          var path = 'parsel/' + mah + '/' + ada + '/' + n;
          req(path, function (err, d) {
            if (!err && d && d.properties) { found.push(d); }
            active--; done++;
            var pc = document.getElementById('pcount');
            if (pc) pc.textContent = found.length;
            if (done >= Math.min(idx, limit) && idx >= limit && active === 0) finish();
            else if (idx < limit) next();
            else if (active === 0 && idx >= limit) finish();
          });
        })(idx);
      }
      if (idx >= limit && active === 0) finish();
    }

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      busy(false);
      found.forEach(function (f) { layerAda.addData(f); });
      if (found.length) {
        try { map.fitBounds(layerAda.getBounds().pad(0.15)); } catch (e) {}
      }
      var top = found.reduce(function (a, b) {
        return (parseFloat(String(b.properties.alan).replace(',', '.')) || 0) >
               (parseFloat(String(a.properties.alan).replace(',', '.')) || 0) ? b : a;
      }, found[0] || { properties: {} });
      show('<div class="ok"><b>' + ada + '</b> adasında <b>' + found.length +
           '</b> parsel bulundu (1–' + limit + ' tarandı).</div>' +
           (found.length ? '<div class="kv"><span>En büyük</span><span><b>' +
             (top.properties.ozet || '—') + '</b> · ' + fmt(top.properties.alan) + ' m²</span></div>' : '') +
           '<div class="hint" style="margin-top:6px">Turuncu poligonlar bu adadaki parseller. Tek tek görmek için parsel no gir.</div>');
    }

    next();
  }

  $('btn-ada').addEventListener('click', adaListele);

  // ---- koordinat sorgu ----
  function koordSor() {
    var la = parseFloat(elLat.value.replace(',', '.')),
        lo = parseFloat(elLon.value.replace(',', '.'));
    if (isNaN(la) || isNaN(lo)) { msg('Geçerli enlem/boylam gir.', 'err'); return; }
    if (la < 35 || la > 43 || lo < 25 || lo > 46) { msg('Koordinat Türkiye sınırları dışında (enlem 35-43, boylam 25-46).', 'err'); return; }

    var path = 'parsel/' + la + '/' + lo;
    busy(true, 'Koordinat sorgulanıyor…');
    req(path, function (err, d) {
      busy(false);
      if (err) { msg('Bu noktada parsel yok.<br><span class="hint">' + err + '</span>', 'err'); return; }
      layerMahalle.clearLayers();
      if (marker) { map.removeLayer(marker); }
      marker = L.circleMarker([la, lo], { radius: 6, color: '#d9822b', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map);
      drawParsel(d, 'parsel/' + la + '/' + lo);
    });
  }
  $('btn-coord').addEventListener('click', koordSor);
  elLon.addEventListener('keydown', function (e) { if (e.key === 'Enter') koordSor(); });

  // haritaya tıklama — aşağıda bağlanır (aşağıdaki init bloğuna bak)

  // ---- sekmeler ----
  function tab(which) {
    var map = { adm: 'pane-adm', coord: 'pane-coord', imar: 'pane-imar' };
    Object.keys(map).forEach(function (k) {
      $(map[k]).style.display = (k === which)
        ? (k === 'adm' ? 'contents' : 'flex') : 'none';
      var b = $('tb-' + k);
      b.className = (k === which) ? 'on' : 'sec';
    });
  }
  $('tb-adm').addEventListener('click', function () { tab('adm'); });
  $('tb-coord').addEventListener('click', function () { tab('coord'); });
  $('tb-imar').addEventListener('click', function () { tab('imar'); });

  // ---- indirme menüsü ----
  var hasParsel = false;
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

  function indir(fmt) {
    if (!state.mahId || !state.ada || !state.parsel) {
      msg('İndirmek için önce ada/parsel sorgula.', 'err'); return;
    }
    var u = API + 'parsel/download/' + state.mahId + '/' + state.ada + '/' + state.parsel + '/' + fmt;
    msg('İndiriliyor: <b>' + fmt.toUpperCase() + '</b> — ' + (state.ada + '/' + state.parsel) +
        '<div class="hint" style="margin-top:6px"><a href="' + u + '" target="_blank" style="color:#6db3ff">Dosya açılmazsa buraya dokun</a></div>', 'ok');
    window.open(u, '_blank');
  }

  // ---- temizle ----
  $('btn-clear').addEventListener('click', function () {
    layerMahalle.clearLayers(); layerParsel.clearLayers(); layerMulti.clearLayers();
    measureLayer.clearLayers(); measurePts=[]; toolMode=null; currentGeo=null;
    if (typeof layerAda !== 'undefined') layerAda.clearLayers();
    if (marker) { map.removeLayer(marker); marker = null; }
    elIl.value = ''; fill(elIlce, [], 'İlçe…'); fill(elMah, [], 'Mahalle…');
    elAda.value = ''; elParsel.value = '';
    state = { mahId: null, ada: null, parsel: null };
    map.setView([39.0, 35.3], 6);
    msg('Temizlendi.', 'ok');
  });

  // ---- favoriler / GPS / ölçüm / WMS / dış bağlantılar ----
  var toolMode = null, measurePts = [], measureLayer = L.layerGroup().addTo(map), wmsLayer = null;

  function renderFavs() {
    var arr = JSON.parse(localStorage.getItem('kadastro-favoriler') || '[]');
    $('favlist').innerHTML = arr.length ? arr.map(function (x, i) {
      return '<div class="favrow"><span><b>' + x.ozet + '</b> · ' + (x.alan || '') + ' m²</span>' +
        '<span><button class="sec" data-fi="' + i + '">Göster</button> <button class="sec" data-fd="' + i + '">Sil</button></span></div>';
    }).join('') : '<span class="hint">Favori yok.</span>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-fi]'), function (b) {
      b.onclick = function () { var x = arr[+b.dataset.fi]; drawParsel(x.geo, 'favori'); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-fd]'), function (b) {
      b.onclick = function () { arr.splice(+b.dataset.fd, 1); localStorage.setItem('kadastro-favoriler', JSON.stringify(arr)); renderFavs(); };
    });
  }
  $('btn-tools').onclick = function () { $('toolpanel').classList.toggle('on'); renderFavs(); setTimeout(function(){map.invalidateSize();},50); };
  $('btn-fav').onclick = function () {
    if (!currentGeo) { msg('Önce bir parsel sorgula.', 'err'); return; }
    var arr = JSON.parse(localStorage.getItem('kadastro-favoriler') || '[]'), p = currentGeo.properties || {};
    if (!arr.some(function(x){ return x.ozet === p.ozet; })) arr.push({ozet:p.ozet, alan:p.alan, geo:currentGeo});
    localStorage.setItem('kadastro-favoriler', JSON.stringify(arr)); renderFavs(); msg(p.ozet + ' favorilere eklendi.', 'ok');
  };
  $('multi').onchange = function () { if (!this.checked) layerMulti.clearLayers(); };

  $('btn-gps').onclick = function () {
    if (!navigator.geolocation) { msg('Bu tarayıcı konum desteklemiyor.', 'err'); return; }
    busy(true, 'GPS konumu alınıyor…');
    navigator.geolocation.getCurrentPosition(function (p) {
      elLat.value = p.coords.latitude.toFixed(7); elLon.value = p.coords.longitude.toFixed(7);
      busy(false); tab('coord'); koordSor();
    }, function (e) { busy(false); msg('Konum alınamadı: ' + e.message, 'err'); }, {enableHighAccuracy:true, timeout:15000});
  };

  function hav(a,b){ var R=6371000, r=Math.PI/180, p1=a.lat*r,p2=b.lat*r,dp=(b.lat-a.lat)*r,dl=(b.lng-a.lng)*r; var q=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 2*R*Math.asin(Math.sqrt(q)); }
  function polyArea(ps){ if(ps.length<3)return 0; var R=6378137, lat0=ps.reduce(function(s,p){return s+p.lat;},0)/ps.length*Math.PI/180, a=0; for(var i=0;i<ps.length;i++){var p=ps[i],q=ps[(i+1)%ps.length]; var x1=R*p.lng*Math.PI/180*Math.cos(lat0),y1=R*p.lat*Math.PI/180,x2=R*q.lng*Math.PI/180*Math.cos(lat0),y2=R*q.lat*Math.PI/180;a+=x1*y2-x2*y1;} return Math.abs(a/2); }
  function updateMeasure(){ measureLayer.clearLayers(); if(!measurePts.length)return; L.polyline(measurePts,{color:'#ff5c8a',weight:3}).addTo(measureLayer); measurePts.forEach(function(p){L.circleMarker(p,{radius:4,color:'#fff',fillColor:'#ff5c8a',fillOpacity:1}).addTo(measureLayer);}); }
  $('btn-measure').onclick = function () { $('toolpanel').classList.add('on'); toolMode='measure'; measurePts=[]; updateMeasure(); msg('Haritada ölçüm noktalarına dokun. Sonra “Ölçümü Bitir”.','ok'); };
  $('btn-measure-clear').onclick = function(){toolMode=null;measurePts=[];measureLayer.clearLayers();msg('Ölçüm temizlendi.','ok');};
  $('btn-measure-finish').onclick = function(){ var typ=$('measure-type').value; if(typ==='area'){if(measurePts.length>2)L.polygon(measurePts,{color:'#ff5c8a',fillOpacity:.15}).addTo(measureLayer); msg('Yaklaşık alan: <b>'+fmt(polyArea(measurePts))+' m²</b>','ok');} else {var d=0;for(var i=1;i<measurePts.length;i++)d+=hav(measurePts[i-1],measurePts[i]);msg('Yaklaşık mesafe: <b>'+fmt(d)+' m</b>','ok');} toolMode=null; };

  // Doğrulanmış açık imar servisleri. Katman yalnız uygun il seçilince etkinleşir.
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
    activeImarKey = key && IMAR_LAYERS[key] ? key : null;
    var b = $('btn-auto-imar'), s = $('wms-status');
    if (!activeImarKey) {
      b.disabled = true; b.textContent = 'İmar katmanı yok'; b.style.background = '';
      s.textContent = 'Bu il için doğrulanmış açık WMS/ArcGIS imar servisi bulunamadı.';
      return;
    }
    var cfg = IMAR_LAYERS[activeImarKey];
    wmsLayer = L.tileLayer.wms(cfg.url, {layers:cfg.layers,format:'image/png',transparent:true,opacity:.68,version:cfg.version}).addTo(map);
    b.disabled = false; b.textContent = '✓ İmar katmanı açık'; b.style.background = '#168f55';
    s.textContent = cfg.title + ' · kadastro üzerine bindirildi';
  }
  $('btn-auto-imar').onclick = function(){
    if (!activeImarKey) return;
    if (wmsLayer && map.hasLayer(wmsLayer)) { map.removeLayer(wmsLayer); this.textContent='İmar katmanını aç'; this.style.background=''; }
    else { setAutoImar(activeImarKey); }
  };
  $('btn-wms-clear').onclick = function(){ if(wmsLayer){map.removeLayer(wmsLayer);wmsLayer=null;} $('btn-auto-imar').textContent=activeImarKey?'İmar katmanını aç':'İmar katmanı yok'; $('btn-auto-imar').style.background=''; msg('İmar katmanı kapatıldı.','ok'); };

  function centerOfCurrent(){ if(!currentGeo)return null; try{return L.geoJSON(currentGeo).getBounds().getCenter();}catch(e){return null;} }
  $('btn-google').onclick = function(){var c=centerOfCurrent()||map.getCenter();window.open('https://www.google.com/maps/search/?api=1&query='+c.lat+','+c.lng,'_blank');};
  $('btn-tkgm').onclick = function(){window.open('https://parselsorgu.tkgm.gov.tr/','_blank');};

  // ---- e-İmar: doğrulanmış belediye imar/CBS portalları ----
  // Sadece canlı test edilip yanıt veren ve imar/CBS içeriği taşıyan adresler.
  // Anahtar: il adı (küçük harf, Türkçe karaktersiz). Değer: {url, ad}
  var IMAR = {
    'adana':      { url: 'https://keos.adana.bel.tr',              ad: 'Adana BB — KEOS İmar Sorgu' },
    'ankara':     { url: 'https://eimar.ankara.bel.tr',            ad: 'Ankara BB — CBSIMAR e-İmar' },
    'antalya':    { url: 'https://kbs.antalya.bel.tr/portalvatandas/', ad: 'Antalya BB — İmar Plan Uygulaması' },
    'balikesir':  { url: 'https://imar.balikesir.bel.tr',          ad: 'Balıkesir BB — İmar Sorgu' },
    'gaziantep':  { url: 'https://keos.gaziantep.bel.tr',          ad: 'Gaziantep BB — KEOS' },
    'istanbul':   { url: 'https://sehirharitasi.ibb.gov.tr',       ad: 'İBB — Şehir Haritası / İmar' },
    'izmir':      { url: 'https://cbs.izmir.bel.tr',               ad: 'İzmir BB — CBS' },
    'kayseri':    { url: 'https://cbs.kayseri.bel.tr',             ad: 'Kayseri BB — CBS Kent Rehberi' },
    'mugla':      { url: 'https://cbs.mugla.bel.tr',               ad: 'Muğla BB — CBS' },
    'ordu':       { url: 'https://cbs.ordu.bel.tr',                ad: 'Ordu BB — Adres Bilgi Kartı' }
  };

  // Türkçe karakterleri sadeleştirip anahtar üret
  function imarKey(s) {
    return (s || '').toLowerCase()
      .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
      .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
      .replace(/\s+/g, '');
  }

  function initImar() {
    var sel = $('imar-il');
    var keys = Object.keys(IMAR).sort(function (a, b) {
      return IMAR[a].ad.localeCompare(IMAR[b].ad, 'tr');
    });
    sel.innerHTML = '<option value="">İl…</option>';
    keys.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = IMAR[k].ad.split('—')[0].trim();
      sel.appendChild(o);
    });
  }

  $('imar-il').addEventListener('change', function () {
    var k = $('imar-il').value;
    setAutoImar(k);
    var ilceSel = $('imar-ilce');
    ilceSel.innerHTML = '<option value="">İlçe yükleniyor…</option>';
    ilceSel.disabled = true;
    $('btn-imar').disabled = true;
    if (!k) { ilceSel.innerHTML = '<option value="">İlçe…</option>'; msg('e-imar için il seç.', 'err'); return; }
    var it = IMAR[k];

    // TKGM il/ilçe listesinden yalnız seçilen ilin ilçelerini doldur.
    req('idariYapi/ilListe', function (err, d) {
      var il = !err && d && (d.features || []).filter(function (f) {
        return imarKey(f.properties.text) === k;
      })[0];
      if (!il) {
        ilceSel.innerHTML = '<option value="genel">İl geneli</option>';
        ilceSel.disabled = false; $('btn-imar').disabled = false; return;
      }
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

    show('<div class="ok"><b>' + it.ad + '</b></div>' +
         '<div class="kv"><span>Kurum</span><span><b>' + it.ad.split('—')[0].trim() + '</b></span>' +
         '<span>Adres</span><span><a href="' + it.url + '" target="_blank" style="color:#6db3ff">' + it.url + '</a></span></div>' +
         '<div class="hint" style="margin-top:8px">İlçeyi seç; belediyenin kendi portalı açılır. Portal içinde ada/parseli yeniden girmen gerekebilir.</div>');
  });

  $('imar-ilce').addEventListener('change', function () {
    var k = $('imar-il').value;
    var ilce = $('imar-ilce').selectedOptions[0];
    $('btn-imar').disabled = !k || !$('imar-ilce').value;
    if (k && ilce && $('imar-ilce').value) {
      msg('<b>' + ilce.textContent + '</b> için ' + IMAR[k].ad + ' açılmaya hazır.', 'ok');
    }
  });

  $('btn-imar').addEventListener('click', function () {
    var k = $('imar-il').value;
    if (!k) { msg('e-imar için il seç.', 'err'); return; }
    window.open(IMAR[k].url, '_blank');
  });

  initImar();

  // ---- başlat ----
  setTimeout(function () { map.invalidateSize(); }, 300);
  window.addEventListener('resize', function () { map.invalidateSize(); });
  map.on('click', function (e) {
    if (toolMode === 'measure') {
      measurePts.push(e.latlng); updateMeasure();
      var typ = $('measure-type').value, val = 0;
      if (typ === 'distance') for (var i=1;i<measurePts.length;i++) val += hav(measurePts[i-1], measurePts[i]);
      else val = polyArea(measurePts);
      msg((typ === 'distance' ? 'Mesafe: <b>'+fmt(val)+' m</b>' : 'Alan: <b>'+fmt(val)+' m²</b>') + ' · '+measurePts.length+' nokta','ok');
      return;
    }
    elLat.value = e.latlng.lat.toFixed(6);
    elLon.value = e.latlng.lng.toFixed(6);
    tab('coord');
    koordSor();
  });
  loadIl();
})();