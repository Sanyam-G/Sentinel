(function() {
    'use strict';

    const CONFIG = {
        target: { coords: [42.8864, -78.8784], name: 'My Server', location: 'Buffalo, NY' },
        polling: { interval: 1500, endpoint: '/api/poll', statsEndpoint: '/api/stats' },
        animation: { duration: { min: 1800, max: 2800 }, trailFadeTime: 60000 },
        ui: { maxLogItems: 100 }
    };

    const state = { lastId: 0, trails: [], attacksInLog: [] };

    const dom = {
        totalAttacks: document.getElementById('total-attacks'),
        last60: document.getElementById('last-60'),
        uniqueIps: document.getElementById('unique-ips'),
        uniqueCountries: document.getElementById('unique-countries'),
        logList: document.getElementById('log-list'),
        connectionStatus: document.getElementById('connection-status')
    };

    // Map
    const bounds = L.latLngBounds(L.latLng(-60, -170), L.latLng(75, 170));
    const map = L.map('map', {
        center: [20, 0], zoom: 2, minZoom: 2, maxZoom: 10,
        maxBounds: bounds, maxBoundsViscosity: 1.0,
        zoomControl: false, attributionControl: false
    });
    map.setMaxBounds(bounds);
    map.on('drag', function() { map.panInsideBounds(bounds, { animate: false }); });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 10, noWrap: true }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.marker(CONFIG.target.coords, {
        icon: L.divIcon({ className: 'target-marker', iconSize: [20, 20], iconAnchor: [10, 10] })
    }).addTo(map).bindPopup('<strong>' + CONFIG.target.name + '</strong><br>' + CONFIG.target.location);

    // Charts
    Chart.defaults.color = '#606070';
    Chart.defaults.font.family = 'Outfit, sans-serif';
    const chartStats = { users: {}, countries: {} };

    const userChart = new Chart(document.getElementById('userChart'), {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], backgroundColor: '#ff0080', borderRadius: 2, barThickness: 16 }] },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { grid: { display: false }, ticks: { color: '#fff', font: { family: 'Space Mono', size: 11 } } } }
        }
    });

    const countryChart = new Chart(document.getElementById('countryChart'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: ['#ff6b35', '#00d4ff', '#ff0080', '#00ff88', '#8b5cf6'], borderWidth: 0 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '60%',
            plugins: { legend: { position: 'right', labels: { boxWidth: 12, padding: 12, font: { family: 'Space Mono', size: 10 }, color: '#a0a0b0' } } }
        }
    });

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
                if (agoEl) agoEl.textContent = formatSecondsAgo(item.secondsAgo);
            }
        });
        // Clean up entries over 6 hours
        state.attacksInLog = state.attacksInLog.filter(function(item) { return item.secondsAgo < 21600; });
    }

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
            if (!isHistorical && isValidCoords(attack.lat, attack.lon)) spawnProjectile(attack);
        });
        updateCharts();
    }

    function isValidCoords(lat, lon) {
        return typeof lat === 'number' && typeof lon === 'number' && !isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

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

    function setConnectionStatus(connected) {
        dom.connectionStatus.className = 'connection-status' + (connected ? '' : ' error');
        dom.connectionStatus.innerHTML = connected
            ? '<span class="status-dot"></span><span>Connected — Live Data</span>'
            : '<span class="status-dot"></span><span>Connection Error — Retrying...</span>';
    }

    function addLogItem(attack, animate) {
        var empty = dom.logList.querySelector('.log-empty');
        if (empty) empty.remove();

        var item = document.createElement('div');
        item.className = 'log-item' + (animate ? ' animated' : '');

        var time = new Date(attack.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        var secondsAgo = attack.seconds_ago || 0;

        item.innerHTML =
            '<div class="log-item-left">' +
                '<span class="log-ip">' + escapeHtml(attack.ip) + '</span>' +
                '<span class="log-user">user: ' + escapeHtml(attack.user) + '</span>' +
            '</div>' +
            '<div class="log-item-right">' +
                '<span class="log-country">' + escapeHtml(attack.country || 'Unknown') + '</span>' +
                '<span class="log-time">' + time + '</span>' +
                '<span class="log-ago">' + formatSecondsAgo(secondsAgo) + '</span>' +
            '</div>';

        dom.logList.insertBefore(item, dom.logList.firstChild);
        state.attacksInLog.push({ element: item, secondsAgo: secondsAgo });
        while (dom.logList.children.length > CONFIG.ui.maxLogItems) dom.logList.removeChild(dom.logList.lastChild);
    }

    function spawnProjectile(attack) {
        var origin = [attack.lat, attack.lon];
        var target = CONFIG.target.coords;

        var trail = L.polyline([origin, target], { color: '#ff0080', weight: 2, opacity: 0.6 }).addTo(map);
        state.trails.push(trail);
        setTimeout(function() { if (trail._path) { trail._path.style.transition = 'opacity 60s linear'; trail._path.style.opacity = '0'; } }, 100);
        setTimeout(function() { if (map.hasLayer(trail)) map.removeLayer(trail); var idx = state.trails.indexOf(trail); if (idx > -1) state.trails.splice(idx, 1); }, CONFIG.animation.trailFadeTime + 1000);

        var marker = L.marker(origin, { icon: L.divIcon({ className: 'attack-projectile', iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false }).addTo(map);
        var duration = CONFIG.animation.duration.min + Math.random() * (CONFIG.animation.duration.max - CONFIG.animation.duration.min);
        var start = performance.now();

        function animate(now) {
            var progress = Math.min((now - start) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            marker.setLatLng([origin[0] + (target[0] - origin[0]) * eased, origin[1] + (target[1] - origin[1]) * eased]);
            if (progress < 1) requestAnimationFrame(animate); else map.removeLayer(marker);
        }
        requestAnimationFrame(animate);
    }

    function escapeHtml(str) {
        if (str == null) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    document.addEventListener('DOMContentLoaded', function() {
        fetchStats();
        poll();
        setInterval(updateAgoDisplays, 1000);
    });
})();
