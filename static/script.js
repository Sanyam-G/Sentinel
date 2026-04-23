(function() {
    'use strict';

    const CONFIG = {
        target: { coords: [42.8864, -78.8784], name: 'TARGET', location: 'Buffalo, NY' },
        polling: { interval: 1500, endpoint: '/api/poll', statsEndpoint: '/api/stats' },
        animation: { duration: { min: 550, max: 850 }, arcFadeTime: 30000 },
        ui: { maxLogItems: 100, ledCount: 14, sparkSeconds: 60 },
        worldDataUrl: 'https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json'
    };

    // GeoIP country name → GeoJSON country name aliases
    const COUNTRY_ALIASES = {
        'United States': 'United States of America',
        'USA': 'United States of America',
        'Russia': 'Russia',
        'Korea, Republic of': 'South Korea',
        'Republic of Korea': 'South Korea',
        'Korea, Democratic Peoples Republic of': 'North Korea',
        'Czech Republic': 'Czech Republic',
        'Czechia': 'Czech Republic',
        'Burma': 'Myanmar',
        "Cote d'Ivoire": 'Ivory Coast',
        'Côte d’Ivoire': 'Ivory Coast',
        'Viet Nam': 'Vietnam',
        'Iran, Islamic Republic of': 'Iran',
        'Syrian Arab Republic': 'Syria',
        'Taiwan, Province of China': 'Taiwan',
        'Venezuela, Bolivarian Republic of': 'Venezuela',
        'Bolivia, Plurinational State of': 'Bolivia',
        'Moldova, Republic of': 'Moldova',
        'Tanzania, United Republic of': 'United Republic of Tanzania',
        'Macedonia': 'Macedonia',
        'North Macedonia': 'Macedonia',
        'Eswatini': 'Swaziland',
        'Cabo Verde': 'Cape Verde',
        'Congo': 'Republic of the Congo',
        'Congo, Democratic Republic of the': 'Democratic Republic of the Congo',
        'Lao Peoples Democratic Republic': 'Laos',
        'Brunei Darussalam': 'Brunei',
        'Palestine, State of': 'Palestine',
        'Hong Kong': 'Hong Kong S.A.R.',
        'Macao': 'Macao S.A.R',
        'Macau': 'Macao S.A.R'
    };

    const state = {
        lastId: 0,
        attacksInLog: [],
        spark: new Array(CONFIG.ui.sparkSeconds).fill(0),
        svg: null,
        projection: null,
        pathGen: null,
        countryIndex: new Map(),
        countryPaths: new Map(),
        activatedCountries: new Set()
    };

    const dom = {
        totalAttacks: document.getElementById('total-attacks'),
        last60: document.getElementById('last-60'),
        uniqueIps: document.getElementById('unique-ips'),
        uniqueCountries: document.getElementById('unique-countries'),
        logList: document.getElementById('log-list'),
        topStatus: document.getElementById('top-status'),
        topClock: document.getElementById('top-clock'),
        topUptime: document.getElementById('top-uptime'),
        ledRow: document.getElementById('led-row'),
        spark: document.getElementById('spark'),
        mapSvg: document.getElementById('map-svg')
    };

    // Service uptime: computed from server-supplied uptime_seconds + local drift
    state.serverUptimeAtLoad = null;  // seconds reported by server the first time
    state.uptimeLoadMoment = null;    // local Date.now() when we received it

    function setServerUptime(seconds) {
        state.serverUptimeAtLoad = seconds;
        state.uptimeLoadMoment = Date.now();
    }

    function currentUptimeSeconds() {
        if (state.serverUptimeAtLoad == null) return null;
        return state.serverUptimeAtLoad + Math.floor((Date.now() - state.uptimeLoadMoment) / 1000);
    }

    function tickClock() {
        const now = new Date();
        // Target server is in Buffalo, NY. Match the attack-log timezone.
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(now);
        const get = function(t) { const p = parts.find(function(x) { return x.type === t; }); return p ? p.value : '00'; };
        let hh = get('hour'); if (hh === '24') hh = '00';
        const mm = get('minute'), ss = get('second');
        if (dom.topClock) dom.topClock.textContent = hh + ':' + mm + ':' + ss;

        if (dom.topUptime) {
            const up = currentUptimeSeconds();
            if (up == null) {
                dom.topUptime.textContent = '--:--:--';
            } else {
                const eh = String(Math.floor(up / 3600)).padStart(2, '0');
                const em = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
                const es = String(up % 60).padStart(2, '0');
                dom.topUptime.textContent = eh + ':' + em + ':' + es;
            }
        }
    }

    /* ---------- Diagnostic LED row ---------- */

    function initLEDs() {
        if (!dom.ledRow) return;
        for (let i = 0; i < CONFIG.ui.ledCount; i++) {
            const led = document.createElement('span');
            led.className = 'led';
            dom.ledRow.appendChild(led);
        }
    }

    function flickerLED() {
        if (!dom.ledRow) return;
        const leds = dom.ledRow.querySelectorAll('.led');
        if (!leds.length) return;
        const i = Math.floor(Math.random() * leds.length);
        leds[i].classList.add('on');
        setTimeout(function() { leds[i].classList.remove('on'); }, 140 + Math.random() * 120);
    }

    /* ---------- Sparkline ---------- */

    function tickSparkShift() {
        state.spark.shift();
        state.spark.push(0);
        renderSpark();
    }

    function recordSparkHit() {
        state.spark[state.spark.length - 1] += 1;
    }

    function renderSpark() {
        if (!dom.spark) return;
        const ctx = dom.spark.getContext('2d');
        const w = dom.spark.width, h = dom.spark.height;
        ctx.clearRect(0, 0, w, h);
        const max = Math.max(1, Math.max.apply(null, state.spark));
        const n = state.spark.length;
        const barW = w / n;
        ctx.fillStyle = '#e5231b';
        for (let i = 0; i < n; i++) {
            const v = state.spark[i];
            if (v <= 0) continue;
            const bh = Math.max(1, Math.round((v / max) * h));
            ctx.fillRect(Math.floor(i * barW), h - bh, Math.max(1, Math.floor(barW - 0.5)), bh);
        }
    }

    /* ---------- d3 SVG world map ---------- */

    async function initMap() {
        if (!dom.mapSvg || typeof d3 === 'undefined') return;
        const rect = dom.mapSvg.getBoundingClientRect();
        const width = rect.width || 800;
        const height = rect.height || 400;

        state.svg = d3.select(dom.mapSvg)
            .attr('viewBox', '0 0 ' + width + ' ' + height);

        try {
            const geo = await d3.json(CONFIG.worldDataUrl);

            state.projection = d3.geoEquirectangular()
                .fitSize([width, height], geo);
            state.pathGen = d3.geoPath(state.projection);

            // Index features by name for fast lookup
            for (const f of geo.features) {
                const name = f.properties && f.properties.name;
                if (name) state.countryIndex.set(name, f);
            }

            // Graticule (thin dashed lat/lon grid, drawn first)
            const graticule = d3.geoGraticule().step([30, 30]);
            state.svg.append('path')
                .datum(graticule)
                .attr('class', 'graticule')
                .attr('d', state.pathGen);

            // Draw ALL countries dimmed on load; activate on attack
            const countriesLayer = state.svg.append('g').attr('class', 'countries');
            for (const f of geo.features) {
                const name = f.properties && f.properties.name;
                const node = countriesLayer.append('path')
                    .datum(f)
                    .attr('class', 'country')
                    .attr('d', state.pathGen)
                    .node();
                if (name) state.countryPaths.set(name, node);
            }

            state.svg.append('g').attr('class', 'arcs');
            state.svg.append('g').attr('class', 'projectiles');
            state.svg.append('g').attr('class', 'targets');

            // Target marker (Buffalo): square + crosshair + pulse ring
            const [tx, ty] = state.projection([CONFIG.target.coords[1], CONFIG.target.coords[0]]);
            const tg = state.svg.select('.targets');
            // Crosshair arms
            tg.append('line').attr('class', 'target-cross').attr('x1', tx - 10).attr('y1', ty).attr('x2', tx - 4).attr('y2', ty);
            tg.append('line').attr('class', 'target-cross').attr('x1', tx + 4).attr('y1', ty).attr('x2', tx + 10).attr('y2', ty);
            tg.append('line').attr('class', 'target-cross').attr('x1', tx).attr('y1', ty - 10).attr('x2', tx).attr('y2', ty - 4);
            tg.append('line').attr('class', 'target-cross').attr('x1', tx).attr('y1', ty + 4).attr('x2', tx).attr('y2', ty + 10);
            // Core square
            tg.append('rect').attr('class', 'target-dot')
                .attr('x', tx - 2.5).attr('y', ty - 2.5)
                .attr('width', 5).attr('height', 5);
            // Pulse ring
            tg.append('circle').attr('class', 'target-ring').attr('cx', tx).attr('cy', ty).attr('r', 4);
        } catch (e) {
            console.error('Map init error:', e);
        }
    }

    function resolveCountryName(geoipName) {
        if (!geoipName) return null;
        if (COUNTRY_ALIASES[geoipName]) return COUNTRY_ALIASES[geoipName];
        return geoipName;
    }

    function activateCountry(countryName, animate) {
        if (!state.svg || !countryName) return;
        const resolved = resolveCountryName(countryName);
        if (state.activatedCountries.has(resolved)) return;

        const node = state.countryPaths.get(resolved);
        if (!node) {
            if (!state.activatedCountries.has('__unmatched__' + resolved)) {
                state.activatedCountries.add('__unmatched__' + resolved);
                console.log('unmatched country:', countryName, '->', resolved);
            }
            return;
        }

        state.activatedCountries.add(resolved);
        node.classList.add('active');
        if (animate) {
            node.classList.add('fresh');
            setTimeout(function() { node.classList.remove('fresh'); }, 1000);
        }
    }

    function isValidCoords(lat, lon) {
        return typeof lat === 'number' && typeof lon === 'number'
            && !isNaN(lat) && !isNaN(lon)
            && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    function spawnAttack(attack) {
        if (!state.projection) return;

        // Fall back to country centroid for IPs with country-only geolocation.
        let lat = attack.lat, lon = attack.lon;
        if (!isValidCoords(lat, lon)) {
            const resolved = resolveCountryName(attack.country);
            const feature = resolved && state.countryIndex.get(resolved);
            if (feature && d3 && d3.geoCentroid) {
                const c = d3.geoCentroid(feature);
                if (c && isValidCoords(c[1], c[0])) { lon = c[0]; lat = c[1]; }
            }
        }
        if (!isValidCoords(lat, lon)) return;

        const [originX, originY] = state.projection([lon, lat]);
        const [tx, ty] = state.projection([CONFIG.target.coords[1], CONFIG.target.coords[0]]);

        const arcs = state.svg.select('.arcs');
        const projLayer = state.svg.select('.projectiles');

        // Straight ballistic line, drawn in as the projectile travels
        const arcD = 'M' + originX + ',' + originY + ' L' + tx + ',' + ty;
        const arc = arcs.append('path')
            .attr('class', 'attack-arc')
            .attr('d', arcD);
        const arcLen = arc.node().getTotalLength();
        arc.attr('stroke-dasharray', arcLen)
            .attr('stroke-dashoffset', arcLen);

        // Origin tick marks: 4 short crossbars to call out launch point
        const tick = 4;
        const originTicks = projLayer.append('g');
        originTicks.append('line').attr('class', 'origin-tick')
            .attr('x1', originX - tick).attr('y1', originY).attr('x2', originX + tick).attr('y2', originY);
        originTicks.append('line').attr('class', 'origin-tick')
            .attr('x1', originX).attr('y1', originY - tick).attr('x2', originX).attr('y2', originY + tick);
        originTicks.transition().delay(260).duration(300).style('opacity', 0)
            .on('end', function() { originTicks.remove(); });

        const duration = CONFIG.animation.duration.min + Math.random() * (CONFIG.animation.duration.max - CONFIG.animation.duration.min);

        // Draw the line in as the projectile travels (linear, not eased = precise/mechanical)
        arc.transition().duration(duration).ease(d3.easeLinear)
            .attr('stroke-dashoffset', 0);

        // Fade the line after it arrives
        arc.transition().delay(duration + 200)
            .duration(CONFIG.animation.arcFadeTime)
            .style('stroke-opacity', 0)
            .on('end', function() { arc.remove(); });

        // Single sharp square projectile, no halo
        const size = 4;
        const proj = projLayer.append('rect')
            .attr('class', 'attack-projectile')
            .attr('width', size).attr('height', size);

        const pathNode = arc.node();
        const totalLen = pathNode.getTotalLength();
        const startT = performance.now();

        function step(now) {
            const t = Math.min((now - startT) / duration, 1);
            const point = pathNode.getPointAtLength(totalLen * t);
            proj.attr('x', point.x - size / 2).attr('y', point.y - size / 2);
            if (t < 1) requestAnimationFrame(step);
            else {
                proj.remove();
                // Sharp impact: crosshair lines + square flash, very fast
                const len = 9;
                const cross = projLayer.append('g');
                cross.append('line').attr('class', 'impact-cross')
                    .attr('x1', tx - len).attr('y1', ty).attr('x2', tx + len).attr('y2', ty);
                cross.append('line').attr('class', 'impact-cross')
                    .attr('x1', tx).attr('y1', ty - len).attr('x2', tx).attr('y2', ty + len);
                cross.transition().duration(220).style('opacity', 0)
                    .on('end', function() { cross.remove(); });

                const sq = projLayer.append('rect')
                    .attr('class', 'impact-square')
                    .attr('x', tx - 4).attr('y', ty - 4)
                    .attr('width', 8).attr('height', 8);
                sq.transition().duration(180).style('opacity', 0)
                    .on('end', function() { sq.remove(); });
            }
        }
        requestAnimationFrame(step);
    }

    /* ---------- Charts ---------- */

    Chart.defaults.color = '#707070';
    Chart.defaults.font.family = 'IBM Plex Mono, ui-monospace, monospace';
    const chartStats = { users: {}, countries: {} };

    const userChart = new Chart(document.getElementById('userChart'), {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], backgroundColor: '#e5231b', borderRadius: 0, barThickness: 14 }] },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { grid: { display: false }, ticks: { color: '#0a0a0a', font: { family: 'IBM Plex Mono', size: 10 } } } }
        }
    });

    const countryChart = new Chart(document.getElementById('countryChart'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: ['#e5231b', '#0a0a0a', '#707070', '#a8a8a8', '#d4d4d4'], borderWidth: 1, borderColor: '#f5f2eb' }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '62%',
            plugins: { legend: { position: 'right', labels: { boxWidth: 10, padding: 10, font: { family: 'IBM Plex Mono', size: 10 }, color: '#0a0a0a' } } }
        }
    });

    function updateCharts() {
        var sortedUsers = Object.entries(chartStats.users).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
        userChart.data.labels = sortedUsers.map(function(x) { return x[0]; });
        userChart.data.datasets[0].data = sortedUsers.map(function(x) { return x[1]; });
        userChart.update('none');

        var sortedCountries = Object.entries(chartStats.countries).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
        countryChart.data.labels = sortedCountries.map(function(x) { return x[0]; });
        countryChart.data.datasets[0].data = sortedCountries.map(function(x) { return x[1]; });
        countryChart.update('none');
    }

    /* ---------- Log feed ---------- */

    function formatSecondsAgo(seconds) {
        if (seconds < 0) seconds = 0;
        if (seconds < 60) return seconds + 's ago';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
        return Math.floor(seconds / 3600) + 'h ago';
    }

    function updateAgoDisplays() {
        state.attacksInLog.forEach(function(item) {
            item.secondsAgo++;
            if (item.element) {
                var agoEl = item.element.querySelector('.log-ago');
                if (agoEl) agoEl.textContent = formatSecondsAgo(item.secondsAgo).toUpperCase();
            }
        });
        state.attacksInLog = state.attacksInLog.filter(function(item) { return item.secondsAgo < 21600; });
    }

    function addLogItem(attack, animate) {
        var empty = dom.logList.querySelector('.log-empty');
        if (empty) empty.remove();

        var item = document.createElement('div');
        item.className = 'log-item' + (animate ? ' animated' : '');

        var time = new Date(attack.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        var secondsAgo = attack.seconds_ago || 0;

        item.innerHTML =
            '<span class="log-ip">' + escapeHtml(attack.ip) + '</span>' +
            '<div class="log-mid">' +
                '<span class="log-user">' + escapeHtml(attack.user).toUpperCase() + '</span>' +
                '<span class="log-country">' + escapeHtml(attack.country || 'UNKNOWN') + '</span>' +
            '</div>' +
            '<div class="log-right">' +
                '<span class="log-time">' + time + '</span>' +
                '<span class="log-ago">' + formatSecondsAgo(secondsAgo).toUpperCase() + '</span>' +
            '</div>';

        dom.logList.insertBefore(item, dom.logList.firstChild);
        state.attacksInLog.push({ element: item, secondsAgo: secondsAgo });
        while (dom.logList.children.length > CONFIG.ui.maxLogItems) dom.logList.removeChild(dom.logList.lastChild);
    }

    /* ---------- Stats + polling ---------- */

    async function fetchStats() {
        try {
            var res = await fetch(CONFIG.polling.statsEndpoint);
            if (!res.ok) return;
            var data = await res.json();
            dom.totalAttacks.textContent = data.total.toLocaleString();
            dom.last60.textContent = data.last_60_seconds.toLocaleString();
            dom.uniqueIps.textContent = data.unique_ips.toLocaleString();
            dom.uniqueCountries.textContent = data.unique_countries.toLocaleString();
            if (typeof data.uptime_seconds === 'number' && state.serverUptimeAtLoad == null) {
                setServerUptime(data.uptime_seconds);
            }
        } catch (e) { console.error('Stats error:', e); }
    }

    async function poll() {
        try {
            var res = await fetch(CONFIG.polling.endpoint + '?last_id=' + state.lastId);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            setConnectionStatus(true);
            if (data.attacks && data.attacks.length > 0) processAttacks(data.attacks, data.is_historical);
            state.lastId = data.last_id;
            await fetchStats();
        } catch (e) {
            console.error('Poll error:', e);
            setConnectionStatus(false);
        }
        setTimeout(poll, CONFIG.polling.interval);
    }

    function processAttacks(attacks, isHistorical) {
        attacks.forEach(function(attack) {
            chartStats.users[attack.user] = (chartStats.users[attack.user] || 0) + 1;
            chartStats.countries[attack.country || 'Unknown'] = (chartStats.countries[attack.country || 'Unknown'] || 0) + 1;
            addLogItem(attack, !isHistorical);
            // Light up the country on its first attack this session
            activateCountry(attack.country, !isHistorical);
            if (!isHistorical) {
                spawnAttack(attack);
                flickerLED();
                recordSparkHit();
            }
        });
        renderSpark();
        updateCharts();
    }

    function setConnectionStatus(connected) {
        if (!dom.topStatus) return;
        dom.topStatus.className = 'strip-cell status ' + (connected ? 'live' : 'err');
        dom.topStatus.innerHTML = '<span class="dot"></span>' + (connected ? 'LIVE' : 'ERR_RETRY');
    }

    function escapeHtml(str) {
        if (str == null) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    /* ---------- Bootstrap ---------- */

    document.addEventListener('DOMContentLoaded', function() {
        initLEDs();
        renderSpark();
        tickClock();
        initMap();
        fetchStats();
        poll();
        setInterval(updateAgoDisplays, 1000);
        setInterval(tickClock, 1000);
        setInterval(tickSparkShift, 1000);
    });
})();
