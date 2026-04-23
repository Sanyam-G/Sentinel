(function() {
    'use strict';

    const CONFIG = {
        target: { coords: [42.8864, -78.8784], name: 'RASERV', location: 'Buffalo, NY' },
        polling: { interval: 1500, endpoint: '/api/poll', statsEndpoint: '/api/stats' },
        animation: { duration: { min: 1800, max: 2800 }, arcFadeTime: 60000 },
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

    const bootTime = Date.now();

    /* ---------- Clock + uptime ---------- */

    function tickClock() {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        if (dom.topClock) dom.topClock.textContent = hh + ':' + mm + ':' + ss;

        const elapsed = Math.floor((Date.now() - bootTime) / 1000);
        const eh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const em = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const es = String(elapsed % 60).padStart(2, '0');
        if (dom.topUptime) dom.topUptime.textContent = eh + ':' + em + ':' + es;
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

            // Target marker (Buffalo)
            const [tx, ty] = state.projection([CONFIG.target.coords[1], CONFIG.target.coords[0]]);
            const tg = state.svg.select('.targets');
            tg.append('circle').attr('class', 'target-ring').attr('cx', tx).attr('cy', ty).attr('r', 5);
            tg.append('circle').attr('class', 'target-dot').attr('cx', tx).attr('cy', ty).attr('r', 4);
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
        if (!state.projection || !isValidCoords(attack.lat, attack.lon)) return;

        const [originX, originY] = state.projection([attack.lon, attack.lat]);
        const [tx, ty] = state.projection([CONFIG.target.coords[1], CONFIG.target.coords[0]]);

        // Curved arc path (higher arc for drama)
        const mx = (originX + tx) / 2;
        const my = (originY + ty) / 2 - Math.min(90, Math.hypot(tx - originX, ty - originY) * 0.32);
        const arcD = 'M' + originX + ',' + originY + ' Q' + mx + ',' + my + ' ' + tx + ',' + ty;

        const arc = state.svg.select('.arcs').append('path')
            .attr('class', 'attack-arc')
            .attr('d', arcD);

        // Fade arc
        arc.transition()
            .delay(1500)
            .duration(CONFIG.animation.arcFadeTime)
            .style('stroke-opacity', 0)
            .remove();

        // Origin pulse
        const originPulse = state.svg.select('.projectiles').append('circle')
            .attr('class', 'impact')
            .attr('cx', originX).attr('cy', originY).attr('r', 2);
        originPulse.transition().duration(600)
            .attr('r', 10).style('opacity', 0)
            .on('end', function() { originPulse.remove(); });

        // Projectile + halo
        const pathNode = arc.node();
        const totalLen = pathNode.getTotalLength();

        const halo = state.svg.select('.projectiles').append('circle')
            .attr('class', 'attack-halo')
            .attr('r', 8);

        const dot = state.svg.select('.projectiles').append('circle')
            .attr('class', 'attack-dot')
            .attr('r', 3.5);

        const duration = CONFIG.animation.duration.min + Math.random() * (CONFIG.animation.duration.max - CONFIG.animation.duration.min);
        const startT = performance.now();

        function step(now) {
            const t = Math.min((now - startT) / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            const point = pathNode.getPointAtLength(totalLen * eased);
            dot.attr('cx', point.x).attr('cy', point.y);
            halo.attr('cx', point.x).attr('cy', point.y);
            if (t < 1) requestAnimationFrame(step);
            else {
                dot.remove();
                halo.remove();
                // Impact flash at target
                const impact = state.svg.select('.projectiles').append('circle')
                    .attr('class', 'impact')
                    .attr('cx', tx).attr('cy', ty).attr('r', 3);
                impact.transition().duration(500)
                    .attr('r', 24).style('opacity', 0)
                    .on('end', function() { impact.remove(); });
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
