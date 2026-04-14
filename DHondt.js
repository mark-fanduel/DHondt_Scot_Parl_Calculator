// D'Hondt Vote Calculator for Scottish Parliament
// Based on 2021 Scottish Parliament Election Results

let parties = [];
let regionData = {};
let darkModeEnabled = false;

// --- Vote transfer UI state ---
// Baseline (loaded from YAML) is immutable; regionData becomes a derived view after applying transfers.
let baselineRegionData = {};

// Multi-slider allocations:
// allocations[region][donor] = {
//   pool: number,
//   to: { [recipientPartyShortName]: number }
// }
let voteAllocations = {};

// Special key for nationwide (all regions) redistribution.
const ALL_REGIONS_KEY = '__ALL_REGIONS__';

// Throttle expensive re-renders while dragging sliders
let pendingFrame = null;
function scheduleRecalcAndRender() {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
        renderPartyInputs();
        results();
    });
}

// YAML data file path (relative to DHondt.html)
const ELECTION_DATA_YAML_PATH = 'election-data.yml';

// Party data structure
class Party {
    constructor(longName, shortName, color) {
        this.longName = longName;
        this.shortName = shortName;
        this.color = color;
    }
}

// Initialize with 2021 Scottish Parliament election results
async function setDefaults() {
    parties = [];

    // 2021 Scottish Parliament Election Results
    // Format: longName, shortName, color
    parties.push(new Party("Scottish National Party", "SNP", "#FBD935"));
    parties.push(new Party("Scottish Conservative and Unionist Party", "Conservatives", "#0087DC"));
    parties.push(new Party("Scottish Labour Party", "Labour", "#EF1C45"));
    parties.push(new Party("Scottish Liberal Democrats", "Lib Dems", "#FAA61A"));
    parties.push(new Party("Scottish Green Party", "Greens", "#63B232"));

    // Load region -> party -> {constituencySeats, regionalVotes} from YAML.
    // NOTE: fetch() generally requires serving this directory via HTTP (not file://).
    try {
        baselineRegionData = await loadElectionDataFromYaml(ELECTION_DATA_YAML_PATH, parties);
        regionData = deepClone(baselineRegionData);
    } catch (e) {
        console.error(e);
        baselineRegionData = {};
        regionData = {};
        showDataLoadError(String(e && e.message ? e.message : e));
    }

    voteAllocations = {};

    renderPartyInputs();
    renderVoteTransferUI();
    results();
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function showDataLoadError(message) {
    let el = document.getElementById('dataLoadError');
    if (!el) {
        el = document.createElement('div');
        el.id = 'dataLoadError';
        el.style.padding = '12px';
        el.style.margin = '12px 0';
        el.style.border = '2px solid #c00';
        el.style.background = darkModeEnabled ? '#3a1a1a' : '#ffecec';
        el.style.color = darkModeEnabled ? '#ffd0d0' : '#900';
        document.body.insertBefore(el, document.body.firstChild);
    }
    el.innerHTML = '<strong>Failed to load election data</strong><br>' + escapeHtml(message) +
        '<br><br><strong>Tip:</strong> open via a local web server (e.g. <code>python3 -m http.server</code>) rather than <code>file://</code>.';
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function loadElectionDataFromYaml(path, partiesList) {
    if (typeof jsyaml === 'undefined' || !jsyaml.load) {
        throw new Error('YAML parser not found. Ensure js-yaml is loaded before DHondt.js');
    }

    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Could not fetch ${path}: ${res.status} ${res.statusText}`);
    }
    const yamlText = await res.text();
    const raw = jsyaml.load(yamlText);
    return normalizeYamlElectionData(raw, partiesList);
}

function normalizeYamlElectionData(raw, partiesList) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Election YAML is empty or not an object');
    }

    const result = {};
    const regions = Object.keys(raw);
    if (regions.length === 0) {
        throw new Error('Election YAML contains no regions');
    }

    for (const regionName of regions) {
        const regionObj = raw[regionName];
        if (!regionObj || typeof regionObj !== 'object') {
            throw new Error(`Region '${regionName}' must map to an object of parties`);
        }

        result[regionName] = {};
        for (const party of partiesList) {
            const pKey = party.shortName;
            const rawParty = regionObj[pKey] || {};

            const cs = toNonNegativeInt(rawParty.constituencySeats);
            // YAML field name: regionalVotes. Internally we keep listVotes to avoid a big refactor.
            const rv = toNonNegativeInt(rawParty.regionalVotes);

            result[regionName][pKey] = { constituencySeats: cs, listVotes: rv };
        }

        // Carry through any additional parties present in YAML but not in partiesList.
        for (const partyKey of Object.keys(regionObj)) {
            if (result[regionName][partyKey]) continue;
            const rawParty = regionObj[partyKey] || {};
            result[regionName][partyKey] = {
                constituencySeats: toNonNegativeInt(rawParty.constituencySeats),
                listVotes: toNonNegativeInt(rawParty.regionalVotes)
            };
        }
    }

    return result;
}

function toNonNegativeInt(v) {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
}

// Render the party input fields
function renderPartyInputs() {
    const voteShareDiv = document.getElementById('VoteShareDiv');
    voteShareDiv.innerHTML = '<h2>Constituency seats and list vote share per party by region</h2>';

    const regions = Object.keys(regionData);

    // Create table header
    let tableHTML = '<div class="table-wrap"><table class="table">';
    tableHTML += '<thead>';
    tableHTML += '<tr>';
    tableHTML += '<th>Party</th>';

    // Header for each region with two columns (Seats and Votes)
    for (let region of regions) {
        tableHTML += '<th colspan="2" style="text-align: center;">' + region + '</th>';
    }
    tableHTML += '</tr>';

    // Sub-header row
    tableHTML += '<tr class="subhead">';
    tableHTML += '<th></th>';
    for (let region of regions) {
        tableHTML += '<th style="text-align: center;">Seats</th>';
        tableHTML += '<th style="text-align: center;">Regional List Votes</th>';
    }
    tableHTML += '</tr>';
    tableHTML += '</thead>';
    tableHTML += '<tbody>';

    // Data rows for each party
    for (let i = 0; i < parties.length; i++) {
        const party = parties[i];
        tableHTML += '<tr>';
        tableHTML += '<td style="font-weight: bold; color: ' + party.color + ';">' + party.shortName + '</td>';

        for (let region of regions) {
            const regionPartyData = regionData[region][party.shortName];
            const seats = regionPartyData.constituencySeats;
            const votes = regionPartyData.listVotes;

            const seatInputId = 'seats_' + region.replace(/\s+/g, '_') + '_' + i;
            const voteInputId = 'votes_' + region.replace(/\s+/g, '_') + '_' + i;

            tableHTML += '<td style="text-align: center;">';
            tableHTML += '<input type="number" id="' + seatInputId + '" value="' + seats + '" style="width: 60px;" onchange="updateRegionalData(\'' + region + '\', \'' + party.shortName + '\', \'seats\')">';
            tableHTML += '</td>';
            tableHTML += '<td style="text-align: center;">';
            tableHTML += '<input type="number" id="' + voteInputId + '" value="' + votes + '" style="width: 110px;" onchange="updateRegionalData(\'' + region + '\', \'' + party.shortName + '\', \'votes\')">';
            tableHTML += '</td>';
        }

        tableHTML += '</tr>';
    }

    tableHTML += '</tbody></table></div>';
    voteShareDiv.innerHTML = voteShareDiv.innerHTML + tableHTML;
}

// Update regional party data from input
function updateRegionalData(region, partyShortName, type) {
    const inputId = (type === 'seats')
        ? 'seats_' + region.replace(/\s+/g, '_') + '_' + parties.findIndex(p => p.shortName === partyShortName)
        : 'votes_' + region.replace(/\s+/g, '_') + '_' + parties.findIndex(p => p.shortName === partyShortName);

    const value = parseInt(document.getElementById(inputId).value) || 0;

    if (type === 'seats') {
        // Seats belong to the baseline scenario; derived view is always baseline + vote allocations.
        if (baselineRegionData[region] && baselineRegionData[region][partyShortName]) {
            baselineRegionData[region][partyShortName].constituencySeats = value;
        }
        // Constituency seats don't interact with allocations, so keep allocations intact.
        regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
    } else if (type === 'votes') {
        // If user edits raw vote numbers directly, treat that as the new baseline for the region.
        // Clear allocations for that region to avoid confusing double-counting against a changed baseline.
        if (baselineRegionData[region] && baselineRegionData[region][partyShortName]) {
            baselineRegionData[region][partyShortName].listVotes = value;
        }
        // Baseline changed; clear any allocations for this region to avoid confusing interactions.
        if (voteAllocations[region]) {
            delete voteAllocations[region];
        }
        regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
        renderVoteTransferUI();
    }
    results();
}

function renderVoteTransferUI() {
    const container = document.getElementById('voteTransferDiv');
    if (!container) return;

    const regions = Object.keys(baselineRegionData || {});
    if (regions.length === 0) {
        container.innerHTML = '<h2>Vote transfers (keep regional total constant)</h2><p>No region data loaded.</p>';
        return;
    }

    const partyKeys = parties.map(p => p.shortName);

    // Current selection defaults
    const defaultRegion = regions[0];
    const defaultDonor = partyKeys[0] || '';

    let html = '';
    html += '<h2>Vote redistribution (keep regional total constant)</h2>';
    html += '<p style="max-width: 950px;">Pick a region and a <strong>donor</strong> party, choose a pool size, then distribute that pool across other parties with sliders. The region total is unchanged. If the pool is fully allocated, sliders won\'t move until you reduce one (freeing votes to re-allocate).</p>';

    // Multi-slider controls
    html += '<div style="border: 1px solid ' + (darkModeEnabled ? '#666' : '#ccc') + '; padding: 12px; border-radius: 6px; margin-bottom: 12px;">';
    html += '<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: end;">';

    html += '<div><label for="vt_region"><strong>Region</strong></label><br>' +
        '<select id="vt_region" style="padding: 6px; min-width: 220px;">' +
        '<option value="' + ALL_REGIONS_KEY + '">All Regions</option>' +
        regions.map(r => '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>').join('') +
        '</select></div>';

    html += '<div><label for="vt_donor"><strong>Donor party</strong></label><br>' +
        '<select id="vt_donor" style="padding: 6px; min-width: 180px;">' +
        partyKeys.map(p => '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>').join('') +
        '</select></div>';

    html += '<div style="flex: 1; min-width: 360px;">' +
        '<label for="vt_pool"><strong>Pool size</strong> <span id="vt_pool_label" style="font-family: monospace;">0</span> &nbsp; ' +
        '<span style="font-family: monospace; opacity: 0.9;">remaining: <span id="vt_remaining">0</span></span>' +
        '</label><br>' +
        '<input id="vt_pool" type="range" min="0" max="0" value="0" step="1" style="width: 100%;">' +
        '<div style="font-size: 12px; opacity: 0.9;">This is the number of donor votes you\'re free to distribute across other parties in this region.</div>' +
        '</div>';

    html += '<div>' +
        '<button id="vt_reset" type="button">Reset transfers</button>' +
        '</div>';

    html += '</div>';
    html += '<div id="vt_preview" style="margin-top: 10px; font-family: monospace;"></div>';
    html += '</div>';

    html += '<div id="vt_sliders"></div>';

    // Existing allocations summary
    html += '<h3>Active redistributions</h3>';
    const allocationRows = [];
    for (const regionName of Object.keys(voteAllocations || {})) {
        for (const donor of Object.keys(voteAllocations[regionName] || {})) {
            const a = voteAllocations[regionName][donor];
            const to = (a && a.to) ? a.to : {};
            const allocated = Object.values(to).reduce((s, v) => s + toNonNegativeInt(v), 0);
            if (toNonNegativeInt(a && a.pool) === 0 && allocated === 0) continue;
            const breakdown = Object.keys(to)
                .filter(k => toNonNegativeInt(to[k]) > 0)
                .map(k => `${k}: ${toNonNegativeInt(to[k]).toLocaleString()}`)
                .join('; ');
            allocationRows.push({ region: regionName, donor, pool: toNonNegativeInt(a.pool), allocated, breakdown });
        }
    }
    if (allocationRows.length === 0) {
        html += '<p><em>None yet.</em></p>';
    } else {
        html += '<div class="table-wrap"><table class="table">';
        html += '<thead><tr>' +
            '<th>Region</th>' +
            '<th>Donor</th>' +
            '<th style="text-align:right;">Pool</th>' +
            '<th style="text-align:right;">Allocated</th>' +
            '<th>Breakdown</th>' +
            '<th style="text-align:center;">Action</th>' +
            '</tr></thead><tbody>';
        for (const row of allocationRows) {
            html += '<tr>' +
                '<td>' + escapeHtml(row.region) + '</td>' +
                '<td>' + escapeHtml(row.donor) + '</td>' +
                '<td style="text-align: right; font-family: monospace;">' + row.pool.toLocaleString() + '</td>' +
                '<td style="text-align: right; font-family: monospace;">' + row.allocated.toLocaleString() + '</td>' +
                '<td>' + escapeHtml(row.breakdown || '') + '</td>' +
                '<td style="text-align: center;">' +
                '<button type="button" onclick="clearAllocation(\'' + escapeHtml(row.region).replaceAll('\\', '\\\\').replaceAll('\'', "\\'") + '\', \'' + escapeHtml(row.donor).replaceAll('\\', '\\\\').replaceAll('\'', "\\'") + '\')">Clear</button>' +
                '</td>' +
                '</tr>';
        }
        html += '</tbody></table></div>';
    }

    container.innerHTML = html;

    // Wire up events
    const regionSel = document.getElementById('vt_region');
    const donorSel = document.getElementById('vt_donor');
    const poolSlider = document.getElementById('vt_pool');
    const poolLabel = document.getElementById('vt_pool_label');
    const remainingEl = document.getElementById('vt_remaining');
    const preview = document.getElementById('vt_preview');
    const resetBtn = document.getElementById('vt_reset');
    const slidersContainer = document.getElementById('vt_sliders');

    // Set dropdown defaults
    regionSel.value = defaultRegion;
    donorSel.value = defaultDonor;

    function ensureAllocation(region, donor) {
        if (!voteAllocations[region]) voteAllocations[region] = {};
        if (!voteAllocations[region][donor]) voteAllocations[region][donor] = { pool: 0, to: {} };
        if (!voteAllocations[region][donor].to) voteAllocations[region][donor].to = {};
        return voteAllocations[region][donor];
    }

    function allocationAllocatedSum(a) {
        if (!a || !a.to) return 0;
        return Object.values(a.to).reduce((s, v) => s + toNonNegativeInt(v), 0);
    }

    function allocationPoolMax(region, donor) {
        if (region === ALL_REGIONS_KEY) {
            // Max pool is the donor's total baseline votes across all regions
            let total = 0;
            for (const r of regions) {
                total += toNonNegativeInt((((baselineRegionData || {})[r] || {})[donor] || {}).listVotes);
            }
            return total;
        }

        const baselineDonorVotes = (((baselineRegionData || {})[region] || {})[donor] || {}).listVotes ?? 0;
        return toNonNegativeInt(baselineDonorVotes);
    }

    function clampAllocation(region, donor) {
        const a = ensureAllocation(region, donor);
        const poolMax = allocationPoolMax(region, donor);
        a.pool = Math.min(toNonNegativeInt(a.pool), poolMax);

        // Clamp recipients and ensure sum(to) <= pool
        for (const k of Object.keys(a.to || {})) {
            a.to[k] = Math.min(toNonNegativeInt(a.to[k]), a.pool);
        }

        let sum = allocationAllocatedSum(a);
        if (sum <= a.pool) return;

        // Reduce largest allocations first until within pool.
        const recipients = Object.keys(a.to)
            .map(k => ({ k, v: toNonNegativeInt(a.to[k]) }))
            .filter(x => x.v > 0)
            .sort((x, y) => y.v - x.v);

        let excess = sum - a.pool;
        for (const r of recipients) {
            if (excess <= 0) break;
            const take = Math.min(r.v, excess);
            a.to[r.k] = r.v - take;
            excess -= take;
        }
    }

    function recomputeRemaining(a) {
        const pool = toNonNegativeInt(a.pool);
        const allocated = allocationAllocatedSum(a);
        return {
            allocated,
            remaining: Math.max(0, pool - allocated)
        };
    }

    function updateRecipientSliderMaxesInPlace(region, donor) {
        const a = ensureAllocation(region, donor);
        clampAllocation(region, donor);

        const { allocated, remaining } = recomputeRemaining(a);
        remainingEl.textContent = remaining.toLocaleString();

        const recipientSliders = slidersContainer.querySelectorAll('.vt_recipient_slider');
        recipientSliders.forEach(sl => {
            const recipient = sl.getAttribute('data-recipient');
            const current = toNonNegativeInt((a.to || {})[recipient]);
            const maxForThis = current + remaining;
            sl.max = String(maxForThis);
            sl.value = String(current);

            const allocSpan = document.getElementById('vt_alloc_' + recipient);
            if (allocSpan) allocSpan.textContent = current.toLocaleString();
        });

        // Preview donors vote effects (uses derived regionData, which might be 1 frame behind while dragging)
        if (region === ALL_REGIONS_KEY) {
            const baselineTotal = allocationPoolMax(ALL_REGIONS_KEY, donor);
            // Derived total for donor across all regions
            let derivedTotal = 0;
            for (const r of regions) {
                derivedTotal += toNonNegativeInt((((regionData || {})[r] || {})[donor] || {}).listVotes);
            }
            preview.textContent = `All Regions | donor ${donor}: ${baselineTotal.toLocaleString()} → ${derivedTotal.toLocaleString()} | pool ${toNonNegativeInt(a.pool).toLocaleString()} / allocated ${allocated.toLocaleString()} / remaining ${remaining.toLocaleString()}`;
        } else {
            const baselineDonor = (((baselineRegionData || {})[region] || {})[donor] || {}).listVotes ?? 0;
            const derivedDonor = (((regionData || {})[region] || {})[donor] || {}).listVotes ?? 0;
            preview.textContent = `${region} | donor ${donor}: ${toNonNegativeInt(baselineDonor).toLocaleString()} → ${toNonNegativeInt(derivedDonor).toLocaleString()} | pool ${toNonNegativeInt(a.pool).toLocaleString()} / allocated ${allocated.toLocaleString()} / remaining ${remaining.toLocaleString()}`;
        }
    }

    function renderRecipientSliders(region, donor) {
        const a = ensureAllocation(region, donor);
        clampAllocation(region, donor);

        const poolMax = allocationPoolMax(region, donor);
        poolSlider.max = String(poolMax);
        poolSlider.value = String(Math.min(toNonNegativeInt(a.pool), poolMax));
        poolLabel.textContent = Number(poolSlider.value || 0).toLocaleString();

        const { allocated, remaining } = recomputeRemaining(a);
        remainingEl.textContent = remaining.toLocaleString();

        // Build slider list
        let slidersHtml = '';
        slidersHtml += '<h3>Distribute pool across recipients</h3>';
        slidersHtml += '<div class="table-wrap"><table class="table">';
        slidersHtml += '<thead><tr>' +
            '<th>Party</th>' +
            '<th style="text-align: right;">Allocated</th>' +
            '<th>Slider</th>' +
            '</tr></thead><tbody>';

        for (const p of partyKeys) {
            if (p === donor) continue;
            const current = toNonNegativeInt((a.to || {})[p]);
            // Each slider can increase up to current + remaining.
            const maxForThis = current + remaining;
            slidersHtml += '<tr>' +
                '<td style="font-weight: bold;">' + escapeHtml(p) + '</td>' +
                '<td style="text-align: right; font-family: monospace;"><span id="vt_alloc_' + escapeHtml(p) + '">' + current.toLocaleString() + '</span></td>' +
                '<td>' +
                '<input type="range" min="0" max="' + maxForThis + '" value="' + current + '" step="1" ' +
                'data-recipient="' + escapeHtml(p) + '" class="vt_recipient_slider" style="width: 100%;">' +
                '</td>' +
                '</tr>';
        }

        slidersHtml += '</tbody></table></div>';
        slidersContainer.innerHTML = slidersHtml;

        // Preview donors/recipients vote effects
        if (region === ALL_REGIONS_KEY) {
            const baselineTotal = allocationPoolMax(ALL_REGIONS_KEY, donor);
            let derivedTotal = 0;
            for (const r of regions) {
                derivedTotal += toNonNegativeInt((((regionData || {})[r] || {})[donor] || {}).listVotes);
            }
            preview.textContent = `All Regions | donor ${donor}: ${baselineTotal.toLocaleString()} → ${derivedTotal.toLocaleString()} | pool ${toNonNegativeInt(a.pool).toLocaleString()} / allocated ${allocated.toLocaleString()} / remaining ${remaining.toLocaleString()}`;
        } else {
            const baselineDonor = (((baselineRegionData || {})[region] || {})[donor] || {}).listVotes ?? 0;
            const derivedDonor = (((regionData || {})[region] || {})[donor] || {}).listVotes ?? 0;
            preview.textContent = `${region} | donor ${donor}: ${toNonNegativeInt(baselineDonor).toLocaleString()} → ${toNonNegativeInt(derivedDonor).toLocaleString()} | pool ${toNonNegativeInt(a.pool).toLocaleString()} / allocated ${allocated.toLocaleString()} / remaining ${remaining.toLocaleString()}`;
        }

        // Wire recipient inputs
        const recipientSliders = slidersContainer.querySelectorAll('.vt_recipient_slider');
        recipientSliders.forEach(sl => {
            sl.addEventListener('input', () => {
                const recipient = sl.getAttribute('data-recipient');
                const newValue = toNonNegativeInt(sl.value);

                // Recompute remaining excluding this slider's current value
                const before = toNonNegativeInt((a.to || {})[recipient]);
                const allocatedExcludingThis = allocationAllocatedSum(a) - before;
                const remainingLocal = Math.max(0, toNonNegativeInt(a.pool) - allocatedExcludingThis);
                const clamped = Math.min(newValue, remainingLocal);
                if (!a.to) a.to = {};
                a.to[recipient] = clamped;

                // Update maxes/labels in place to avoid re-rendering the slider DOM while dragging
                // (re-rendering during drag makes Chrome feel like the sliders don't move).
                updateRecipientSliderMaxesInPlace(region, donor);

                // Recalc/render heavyweight tables at most once per animation frame.
                scheduleRecalcAndRender();
            });

            // Also handle 'change' (mouse up) to ensure everything is fully consistent.
            sl.addEventListener('change', () => {
                regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
                updateRecipientSliderMaxesInPlace(region, donor);
                renderPartyInputs();
                results();
            });
        });
    }

    function onSelectionChanged() {
        const region = regionSel.value;
        const donor = donorSel.value;
        ensureAllocation(region, donor);
        clampAllocation(region, donor);
        // Always derive from the current baselineRegionData (editable via the top table)
        regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
        renderRecipientSliders(region, donor);
    }

    regionSel.addEventListener('change', onSelectionChanged);
    donorSel.addEventListener('change', onSelectionChanged);

    poolSlider.addEventListener('input', () => {
        const region = regionSel.value;
        const donor = donorSel.value;
        const a = ensureAllocation(region, donor);
        a.pool = toNonNegativeInt(poolSlider.value);
        clampAllocation(region, donor);
        regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
        renderRecipientSliders(region, donor);
        renderPartyInputs();
        results();
    });

    resetBtn.addEventListener('click', () => {
        voteAllocations = {};
        regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
        renderPartyInputs();
        renderVoteTransferUI();
        results();
    });

    onSelectionChanged();
}

function clearAllocation(region, donor) {
    if (voteAllocations[region] && voteAllocations[region][donor]) {
        delete voteAllocations[region][donor];
        if (Object.keys(voteAllocations[region]).length === 0) {
            delete voteAllocations[region];
        }
    }
    regionData = applyVoteAllocations(baselineRegionData, voteAllocations);
    renderPartyInputs();
    renderVoteTransferUI();
    results();
}

function applyVoteAllocations(baseline, allocations) {
    const derived = deepClone(baseline || {});
    const allocationRegions = Object.keys(allocations || {});

    // First apply All-Regions allocation (if any), so per-region allocations can override/add on top.
    if (allocations && allocations[ALL_REGIONS_KEY]) {
        const allRegions = Object.keys(derived);
        const donorMap = allocations[ALL_REGIONS_KEY];
        for (const donor of Object.keys(donorMap || {})) {
            const a = donorMap[donor];
            if (!a || !a.to) continue;

            const pool = toNonNegativeInt(a.pool);
            if (pool <= 0) continue;

            // Compute recipient weights based on requested allocations (they sum to <= pool)
            const requested = Object.keys(a.to)
                .filter(k => k !== donor)
                .map(k => ({ k, v: toNonNegativeInt(a.to[k]) }))
                .filter(x => x.v > 0);

            const requestedSum = requested.reduce((s, x) => s + x.v, 0);
            if (requestedSum <= 0) continue;

            // Percentage-consistent nationwide shift:
            // apply the same % change to the donor's baseline votes in each region.
            // shiftPercent = pool / donorTotalBaseline.
            let donorTotalBaseline = 0;
            const donorBaselineByRegion = {};
            for (const regionName of allRegions) {
                const baseVotes = toNonNegativeInt((((baseline || {})[regionName] || {})[donor] || {}).listVotes);
                donorBaselineByRegion[regionName] = baseVotes;
                donorTotalBaseline += baseVotes;
            }
            if (donorTotalBaseline <= 0) continue;

            const shiftPercent = Math.min(1, pool / donorTotalBaseline);

            for (const regionName of allRegions) {
                const region = derived[regionName];
                if (!region || !region[donor]) continue;

                const donorVotes = toNonNegativeInt(region[donor].listVotes);
                const baseVotes = donorBaselineByRegion[regionName];

                // Proposed shift is baseVotes * shiftPercent; clamp to available donor votes in derived.
                const take = Math.min(donorVotes, Math.round(baseVotes * shiftPercent));
                if (take <= 0) continue;

                region[donor].listVotes = donorVotes - take;

                // Distribute to recipients proportionally to requested weights (rounded)
                let remaining = take;
                for (let i = 0; i < requested.length; i++) {
                    const rec = requested[i];
                    if (!region[rec.k]) continue;
                    const isLast = i === requested.length - 1;
                    const give = isLast ? remaining : Math.min(remaining, Math.floor(take * (rec.v / requestedSum)));
                    if (give <= 0) continue;
                    region[rec.k].listVotes = toNonNegativeInt(region[rec.k].listVotes) + give;
                    remaining -= give;
                    if (remaining <= 0) break;
                }
            }
        }
    }

    for (const regionName of allocationRegions) {
        if (regionName === ALL_REGIONS_KEY) continue;
        const regionAlloc = allocations[regionName];
        const region = derived[regionName];
        if (!region || !regionAlloc) continue;

        for (const donor of Object.keys(regionAlloc || {})) {
            const a = regionAlloc[donor];
            if (!a || !a.to) continue;
            if (!region[donor]) continue;

            // Pool is a UX constraint; math uses the allocated sum.
            const allocatedSum = Object.values(a.to).reduce((s, v) => s + toNonNegativeInt(v), 0);
            const donorVotes = toNonNegativeInt(region[donor].listVotes);
            const appliedSum = Math.min(allocatedSum, donorVotes);
            if (appliedSum <= 0) continue;

            // Subtract from donor
            region[donor].listVotes = donorVotes - appliedSum;

            // Add to recipients proportionally to requested amounts (but cap at remaining)
            let remaining = appliedSum;
            for (const recipient of Object.keys(a.to)) {
                if (remaining <= 0) break;
                if (recipient === donor) continue;
                if (!region[recipient]) continue;
                const want = toNonNegativeInt(a.to[recipient]);
                if (want <= 0) continue;
                const give = Math.min(want, remaining);
                region[recipient].listVotes = toNonNegativeInt(region[recipient].listVotes) + give;
                remaining -= give;
            }
        }
    }

    return derived;
}

// Create a party from the "Add additional party" form
function createPartyFromHTML() {
    const longName = document.getElementById('newPartyLongName').value.trim();
    const shortName = document.getElementById('newPartyShortName').value.trim();

    if (!longName || !shortName) {
        alert('Please enter both long and short names for the party.');
        return;
    }

    // Generate a random color for the new party
    const color = '#' + Math.floor(Math.random()*16777215).toString(16);

    parties.push(new Party(longName, shortName, color));

    // Add empty regional data for the new party
    const regions = Object.keys(regionData);
    for (let region of regions) {
        regionData[region][shortName] = { constituencySeats: 0, listVotes: 0 };
    }

    // Clear inputs
    document.getElementById('newPartyLongName').value = '';
    document.getElementById('newPartyShortName').value = '';
    document.getElementById('newPartyConstituencySeats').value = '';
    document.getElementById('newPartyListVotes').value = '';

    renderPartyInputs();
    results();
}

// Remove a party
function removeParty(index) {
    if (confirm(`Remove ${parties[index].longName}?`)) {
        const partyToRemove = parties[index];
        parties.splice(index, 1);

        // Also remove from regional data
        const regions = Object.keys(regionData);
        for (let region of regions) {
            delete regionData[region][partyToRemove.shortName];
        }

        renderPartyInputs();
        results();
    }
}

// D'Hondt Algorithm Implementation - Per Region
function calculateDHondt() {
    // Each region has 7 seats to allocate
    const seatsPerRegion = 7;
    const regions = Object.keys(regionData);

    // Initialize regional list seats for each party in each region
    const regionalListSeats = {};
    for (let region of regions) {
        regionalListSeats[region] = {};
        for (let party of parties) {
            regionalListSeats[region][party.shortName] = 0;
        }
    }

    // Calculate D'Hondt for each region separately
    for (let region of regions) {
        for (let seatNum = 0; seatNum < seatsPerRegion; seatNum++) {
            let highestQuotient = -1;
            let winningPartyName = '';

            // Find party with highest quotient for this seat in this region
            for (let party of parties) {
                const partyShortName = party.shortName;
                const regionPartyData = regionData[region][partyShortName];

                // Total seats already won by this party in this region (constituency + allocated list seats)
                const totalSeatsWon = regionPartyData.constituencySeats + regionalListSeats[region][partyShortName];

                // Quotient for next seat is: votes / (total seats won + 1)
                const quotient = regionPartyData.listVotes / (totalSeatsWon + 1);

                if (quotient > highestQuotient) {
                    highestQuotient = quotient;
                    winningPartyName = partyShortName;
                }
            }

            // Award the seat to the winning party
            if (winningPartyName !== '') {
                regionalListSeats[region][winningPartyName]++;
            }
        }
    }

    // Store regional list seats in party objects for display
    for (let party of parties) {
        party.regionalListSeats = regionalListSeats;
    }
}

// Calculate and display results
function results() {
    calculateDHondt();

    // Calculate totals across all regions
    const totals = {};
    for (let party of parties) {
        totals[party.shortName] = {
            constituencySeats: 0,
            listVotes: 0,
            regionalListSeats: 0
        };
    }

    const regions = Object.keys(regionData);
    for (let region of regions) {
        for (let party of parties) {
            totals[party.shortName].constituencySeats += regionData[region][party.shortName].constituencySeats;
            totals[party.shortName].listVotes += regionData[region][party.shortName].listVotes;
            if (parties[0].regionalListSeats && parties[0].regionalListSeats[region]) {
                totals[party.shortName].regionalListSeats += parties[0].regionalListSeats[region][party.shortName] || 0;
            }
        }
    }

    // --- Charts (shown first) ---
    let resultsHTML = '<h2>Seat distribution</h2>';

    const overallChartData = parties.map(p => {
        const constituencySeats = totals[p.shortName].constituencySeats;
        const listSeats = totals[p.shortName].regionalListSeats;
        const total = constituencySeats + listSeats;
        return {
            label: p.shortName,
            value: total,
            color: p.color,
            detail: `${constituencySeats} constituency + ${listSeats} list = ${total}`
        };
    }).filter(d => d.value > 0);

    resultsHTML += '<div style="display:flex; flex-wrap:wrap; gap: 18px; align-items: flex-start;">';
    resultsHTML += '<div style="min-width: 320px;">' + renderPieChartSvg(overallChartData, {
        title: 'Overall seats (129)',
        size: 300
    }) + '</div>';

    // Region pies (small multiples)
    resultsHTML += '<div style="flex: 1; min-width: 360px;">';
    resultsHTML += '<h3 style="margin-top: 0;">By region</h3>';
    resultsHTML += '<div style="display:flex; flex-wrap: wrap; gap: 14px;">';
    for (const region of regions) {
        const regionDataForChart = parties.map(p => {
            const constituency = regionData[region][p.shortName].constituencySeats;
            const list = parties[0].regionalListSeats && parties[0].regionalListSeats[region] ? (parties[0].regionalListSeats[region][p.shortName] || 0) : 0;
            const total = constituency + list;
            return {
                label: p.shortName,
                value: total,
                color: p.color,
                detail: `${constituency} constituency + ${list} list = ${total}`
            };
        }).filter(d => d.value > 0);

        resultsHTML += '<div style="width: 210px;">' + renderPieChartSvg(regionDataForChart, {
            title: region,
            size: 190
        }) + '</div>';
    }
    resultsHTML += '</div></div>';
    resultsHTML += '</div>';

    // --- Overall Results Table
    resultsHTML += '<h2>Overall Results</h2>';
    resultsHTML += '<div class="table-wrap"><table class="table">';
    resultsHTML += '<thead><tr>';
    resultsHTML += '<th>Party</th>';
    resultsHTML += '<th style="text-align:center;">Constituency Seats</th>';
    resultsHTML += '<th style="text-align:center;">List Votes</th>';
    resultsHTML += '<th style="text-align:center;">Regional List Seats</th>';
    resultsHTML += '<th style="text-align:center;">Total Seats</th>';
    resultsHTML += '</tr></thead><tbody>';

    for (let party of parties) {
        const totalSeats = totals[party.shortName].constituencySeats + totals[party.shortName].regionalListSeats;
        resultsHTML += '<tr>';
        resultsHTML += '<td style="font-weight: bold; color: ' + party.color + ';">' + party.shortName + '</td>';
        resultsHTML += '<td style="text-align: center;">' + totals[party.shortName].constituencySeats + '</td>';
        resultsHTML += '<td style="text-align: center;">' + totals[party.shortName].listVotes.toLocaleString() + '</td>';
        resultsHTML += '<td style="text-align: center;">' + totals[party.shortName].regionalListSeats + '</td>';
        resultsHTML += '<td style="text-align: center; font-weight: bold;">' + totalSeats + '</td>';
        resultsHTML += '</tr>';
    }

    resultsHTML += '</tbody></table></div>';

    // Regional Results
    resultsHTML += '<h2 style="margin-top: 40px;">Results by Region</h2>';

    for (let region of regions) {
        resultsHTML += '<h3>' + region + '</h3>';
        resultsHTML += '<div class="table-wrap"><table class="table">';
        resultsHTML += '<thead><tr>';
        resultsHTML += '<th>Party</th>';
        resultsHTML += '<th style="text-align:center;">Constituency Seats</th>';
        resultsHTML += '<th style="text-align:center;">List Votes</th>';
        resultsHTML += '<th style="text-align:center;">Regional List Seats</th>';
        resultsHTML += '<th style="text-align:center;">Total Seats</th>';
        resultsHTML += '</tr></thead><tbody>';

        for (let party of parties) {
            const regionPartyData = regionData[region][party.shortName];
            const constituencySeats = regionPartyData.constituencySeats;
            const listVotes = regionPartyData.listVotes;
            const regionalListSeats = parties[0].regionalListSeats && parties[0].regionalListSeats[region] ? (parties[0].regionalListSeats[region][party.shortName] || 0) : 0;
            const totalSeats = constituencySeats + regionalListSeats;
            resultsHTML += '<tr>';
            resultsHTML += '<td style="font-weight: bold; color: ' + party.color + ';">' + party.shortName + '</td>';
            resultsHTML += '<td style="text-align: center;">' + constituencySeats + '</td>';
            resultsHTML += '<td style="text-align: center;">' + listVotes.toLocaleString() + '</td>';
            resultsHTML += '<td style="text-align: center;">' + regionalListSeats + '</td>';
            resultsHTML += '<td style="text-align: center; font-weight: bold;">' + totalSeats + '</td>';
            resultsHTML += '</tr>';
        }

        resultsHTML += '</tbody></table></div>';
    }

    document.getElementById('seats').innerHTML = resultsHTML;
}

function renderPieChartSvg(items, opts) {
    const title = (opts && opts.title) ? String(opts.title) : '';
    const size = (opts && opts.size) ? Number(opts.size) : 260;
    const radius = Math.floor(size * 0.36);
    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    const stroke = 'var(--chart-slice-stroke, rgba(0,0,0,0.25))';

    const total = items.reduce((s, i) => s + (Number(i.value) || 0), 0);
    if (total <= 0) {
        return '<div style="opacity:0.8;">No seats</div>';
    }

    let startAngle = -Math.PI / 2;
    const paths = [];

    for (const it of items) {
        const v = Number(it.value) || 0;
        if (v <= 0) continue;
        const frac = v / total;
        const endAngle = startAngle + frac * Math.PI * 2;
        const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;

        const x1 = cx + radius * Math.cos(startAngle);
        const y1 = cy + radius * Math.sin(startAngle);
        const x2 = cx + radius * Math.cos(endAngle);
        const y2 = cy + radius * Math.sin(endAngle);

        const d = [
            `M ${cx} ${cy}`,
            `L ${x1.toFixed(2)} ${y1.toFixed(2)}`,
            `A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
            'Z'
        ].join(' ');

        const percent = (frac * 100);
        const label = escapeHtml(it.label);
        const detail = escapeHtml(it.detail || `${v}`);
        paths.push(
            `<path d="${d}" fill="${it.color}" stroke="${stroke}" stroke-width="1">` +
            `<title>${label}: ${v} (${percent.toFixed(1)}%)\n${detail}</title>` +
            `</path>`
        );

        startAngle = endAngle;
    }

    // Legend
    const legendItems = [...items]
        .filter(i => (Number(i.value) || 0) > 0)
        .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))
        .map(i => {
            const v = Number(i.value) || 0;
            const pct = total > 0 ? (v / total * 100) : 0;
            return `<div style="display:flex; align-items:center; gap:8px; margin: 3px 0;">` +
                `<span style="width: 12px; height: 12px; border-radius: 3px; background:${i.color}; border: 1px solid ${stroke}; display:inline-block;"></span>` +
                `<span style="flex: 1;">${escapeHtml(i.label)}</span>` +
                `<span style="font-family: monospace;">${v}</span>` +
                `<span style="opacity:0.85; font-family: monospace;">(${pct.toFixed(1)}%)</span>` +
                `</div>`;
        }).join('');

    return `
<div class="chart-card">
  <div style="font-weight: bold; margin-bottom: 8px;">${escapeHtml(title)}</div>
  <div style="display:flex; gap: 12px; align-items: center; flex-wrap: wrap;">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(title)}">
      ${paths.join('')}
    </svg>
    <div style="min-width: 160px;">
      ${legendItems}
    </div>
  </div>
</div>`;
}

// Dark mode toggle
function darkMode() {
    darkModeEnabled = !darkModeEnabled;

    // Toggle a class so CSS can theme tables/inputs consistently.
    if (darkModeEnabled) {
        document.body.classList.add('dark');
    } else {
        document.body.classList.remove('dark');
    }

    if (darkModeEnabled) {
        document.body.style.backgroundColor = '#1a1a1a';
        document.body.style.color = '#e0e0e0';
        document.body.style.fontFamily = 'Arial, sans-serif';
        document.getElementById('darkModeButton').textContent = 'LIGHT MODE - PROCEED';
        document.getElementById('darkModeButton').style.backgroundColor = '#444';
        document.getElementById('darkModeButton').style.color = '#e0e0e0';
        document.getElementById('darkModeButton').style.padding = '10px 20px';
        document.getElementById('darkModeButton').style.fontSize = '16px';
        document.getElementById('darkModeButton').style.cursor = 'pointer';
        document.getElementById('darkModeButton').style.border = '2px solid #666';

        const settingsBtn = document.getElementById('settingsButton');
        if (settingsBtn) {
            settingsBtn.style.backgroundColor = '#444';
            settingsBtn.style.color = '#e0e0e0';
            settingsBtn.style.border = '2px solid #666';
        }
    } else {
        document.body.style.backgroundColor = '#ffffff';
        document.body.style.color = '#000000';
        document.body.style.fontFamily = 'Arial, sans-serif';
        document.getElementById('darkModeButton').textContent = 'EMO MODE - BEWARE';
        document.getElementById('darkModeButton').style.backgroundColor = '#f0f0f0';
        document.getElementById('darkModeButton').style.color = '#000000';
        document.getElementById('darkModeButton').style.padding = '10px 20px';
        document.getElementById('darkModeButton').style.fontSize = '16px';
        document.getElementById('darkModeButton').style.cursor = 'pointer';
        document.getElementById('darkModeButton').style.border = '2px solid #ccc';

        const settingsBtn = document.getElementById('settingsButton');
        if (settingsBtn) {
            settingsBtn.style.backgroundColor = '#f3f3f3';
            settingsBtn.style.color = '#000000';
            settingsBtn.style.border = '1px solid #bbb';
        }
    }

    renderPartyInputs();
    // Keep modal styling consistent with theme
    applySettingsModalTheme();
    results();
}

function openSettings() {
    const backdrop = document.getElementById('settingsModalBackdrop');
    if (!backdrop) return;
    applySettingsModalTheme();
    backdrop.style.display = 'block';
}

function closeSettings() {
    const backdrop = document.getElementById('settingsModalBackdrop');
    if (!backdrop) return;
    backdrop.style.display = 'none';
}

function applySettingsModalTheme() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    if (darkModeEnabled) {
        modal.style.background = '#222';
        modal.style.color = '#e0e0e0';
        modal.style.border = '1px solid #555';
    } else {
        modal.style.background = '#fff';
        modal.style.color = '#000';
        modal.style.border = '1px solid #ddd';
    }
}

// Apply default light mode styling
window.addEventListener('load', function() {
    // Base styling is now largely in DHondt.html CSS.
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
    inputs.forEach(input => {
        input.style.padding = '8px';
        input.style.marginRight = '10px';
        input.style.marginBottom = '10px';
        input.style.borderRadius = '4px';
        input.style.border = '1px solid #ccc';
    });
});

