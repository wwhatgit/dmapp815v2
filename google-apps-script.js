/**
 * DMapp · BIS — Google Apps Script v5
 *
 * Permanent sheet: https://docs.google.com/spreadsheets/d/1jqtFYsChM8DYC2H4_VPD31QyfeJBA8aQkyEwlNIH4XM
 *
 * Tabs used:
 *   Uni_BS    — bus stop reference (BSCode, BSName, Planned_Lat, Planned_Long, BFC Marker ID)
 *   Uni_Links — link reference (Link, FromStopCode, ToStopCode, Service)
 *   Result    — master result database (all drivers write here)
 *   Plan      — kept but not used by app
 *
 * Actions handled (called by app via JSONP):
 *   getReference  — returns Uni_BS + Uni_Links (used by Task tab to look up names/services)
 *   saveResult    — appends one measurement record to Result tab
 *   getResults    — returns rows from Result tab (filtered by user if ?user= provided)
 *   ping          — health check
 *
 * HOW TO UPDATE (keep same deployment URL):
 *   Extensions → Apps Script → replace ALL code → Save (Ctrl+S)
 *   Deploy → Manage Deployments → click pencil → New version → Deploy
 *   ⚠ DO NOT create a new deployment — the URL must stay the same
 */

// ── Permanent sheet ID (never changes) ──────────────────────────
var PERMANENT_ID = '1jqtFYsChM8DYC2H4_VPD31QyfeJBA8aQkyEwlNIH4XM';

// ── Tab names ────────────────────────────────────────────────────
var TAB_BS     = 'Uni_BS';
var TAB_LINKS  = 'Uni_Links';
var TAB_RESULT = 'Result';

// ── Result tab columns (must match app.js RESULT_HEADERS exactly) ──
// Zone | Run | LinkID | Service | From | To |
// PlannedStartLat | PlannedStartLng | ActualStartLat | ActualStartLng | StartFlag |
// PlannedEndLat   | PlannedEndLng   | ActualEndLat   | ActualEndLng   | EndFlag   |
// GPSDist | RouteDist | DateTime | User | Remarks
var RESULT_HEADERS = [
  'Zone', 'Run', 'LinkID', 'Service', 'From', 'To',
  'PlannedStartLat', 'PlannedStartLng', 'ActualStartLat', 'ActualStartLng', 'StartFlag',
  'PlannedEndLat',   'PlannedEndLng',   'ActualEndLat',   'ActualEndLng',   'EndFlag',
  'GPSDist', 'RouteDist', 'DateTime', 'User', 'Remarks'
];

// ── Open permanent sheet ─────────────────────────────────────────
function getSheet() {
  return SpreadsheetApp.openById(PERMANENT_ID);
}

// ── Main GET handler (JSONP) ─────────────────────────────────────
function doGet(e) {
  var p      = e.parameter || {};
  var cb     = p.callback  || '';
  var result;

  try {
    var action = String(p.action || '').trim();
    var ss     = getSheet();

    switch (action) {
      case 'getReference':
        result = actionGetReference(ss);
        break;
      case 'saveResult':
        result = actionSaveResult(ss, p);
        break;
      case 'getResults':
        result = actionGetResults(ss, p);
        break;
      case 'addNewStop':
        result = actionAddNewStop(ss, p);
        break;
      case 'addNewLink':
        result = actionAddNewLink(ss, p);
        break;
      case 'ping':
        result = { status: 'ok', time: new Date().toISOString(), version: 'v5' };
        break;
      default:
        result = { status: 'ok', message: 'DMapp API v5 ready', actions: ['getReference','saveResult','getResults','ping'] };
    }

  } catch (err) {
    result = { error: err.toString() };
    Logger.log('ERROR in doGet: ' + err.toString());
  }

  var json = JSON.stringify(result);
  var out  = cb ? cb + '(' + json + ')' : json;
  var mime = cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON;
  return ContentService.createTextOutput(out).setMimeType(mime);
}

// POST mirrors GET
function doPost(e) {
  var b = {};
  try { b = JSON.parse(e.postData.contents); } catch (x) {}
  return doGet({ parameter: Object.assign({}, e.parameter, b) });
}

// ── ACTION: getReference ─────────────────────────────────────────
// Returns Uni_BS and Uni_Links so the Task tab can look up
// stop names and service numbers from stop codes.
function actionGetReference(ss) {
  var stops = readTab(ss, TAB_BS);
  var links = readTab(ss, TAB_LINKS);
  return {
    status: 'ok',
    stops:  stops,
    links:  links
  };
}

// ── ACTION: saveResult ───────────────────────────────────────────
// Appends one measurement record to the Result tab.
// Called by app.js jsonpSave() with action='saveResult'.
// All 21 columns must be written in the same order as RESULT_HEADERS.
function actionSaveResult(ss, p) {
  var tab = ss.getSheetByName(TAB_RESULT);

  // Create Result tab if it doesn't exist yet
  if (!tab) {
    tab = ss.insertSheet(TAB_RESULT);
    writeHeader(tab);
  } else {
    // Check header row — insert if missing or wrong
    var firstCell = String(tab.getRange(1, 1).getValue()).trim();
    if (firstCell !== 'Zone') {
      tab.insertRowBefore(1);
      writeHeader(tab);
    }
  }

  // Append the record row — field names match exactly what app.js sends
  tab.appendRow([
    p.Zone             || '',   // 1
    p.Run              || '',   // 2
    p.LinkID           || '',   // 3
    p.Service          || '',   // 4
    p.From             || '',   // 5  (fromStop code)
    p.To               || '',   // 6  (toStop code)
    p.PlannedStartLat  || '',   // 7
    p.PlannedStartLng  || '',   // 8
    p.ActualStartLat   || '',   // 9
    p.ActualStartLng   || '',   // 10
    p.StartFlag        || '',   // 11
    p.PlannedEndLat    || '',   // 12
    p.PlannedEndLng    || '',   // 13
    p.ActualEndLat     || '',   // 14
    p.ActualEndLng     || '',   // 15
    p.EndFlag          || '',   // 16
    p.GPSDist          || '',   // 17
    p.RouteDist        || '',   // 18
    p.DateTime         || '',   // 19  (yyyy-mm-dd hh:mm:ss SGT)
    p.User             || '',   // 20
    p.Remarks          || ''    // 21
  ]);

  return { status: 'saved', row: tab.getLastRow() };
}

// ── ACTION: getResults ───────────────────────────────────────────
// Returns rows from Result tab.
// Optional: filter by ?user=DRIVERNAME (case-insensitive).
function actionGetResults(ss, p) {
  var rows   = readTab(ss, TAB_RESULT);
  var filter = String(p.user || '').trim().toLowerCase();

  if (filter) {
    rows = rows.filter(function(r) {
      return String(r.User || '').trim().toLowerCase() === filter;
    });
  }

  return { status: 'ok', results: rows };
}

// ── HELPER: write header row with formatting ─────────────────────
function writeHeader(tab) {
  var range = tab.getRange(1, 1, 1, RESULT_HEADERS.length);
  range.setValues([RESULT_HEADERS]);
  range.setFontWeight('bold');
  range.setBackground('#e8f0fe');       // light blue header
  range.setFontColor('#1a1a2e');
  tab.setFrozenRows(1);
  // Auto-resize columns
  for (var i = 1; i <= RESULT_HEADERS.length; i++) {
    tab.setColumnWidth(i, 100);
  }
  // Wider columns for names/coords
  tab.setColumnWidth(3, 140);   // LinkID
  tab.setColumnWidth(19, 140);  // DateTime
  tab.setColumnWidth(20, 100);  // User
}

// ── HELPER: read tab → array of row objects ──────────────────────
// First row = headers. Empty rows are skipped.
function readTab(ss, tabName) {
  var tab = ss.getSheetByName(tabName);
  if (!tab) {
    Logger.log('Tab not found: ' + tabName);
    return [];
  }

  var lastRow = tab.getLastRow();
  var lastCol = tab.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  var data    = tab.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows    = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // Skip completely empty rows
    var isEmpty = row.every(function(c) {
      return c === '' || c === null || c === undefined;
    });
    if (isEmpty) continue;

    var obj = {};
    headers.forEach(function(h, j) {
      var val = row[j];
      // Convert Date objects to string
      if (val instanceof Date) {
        val = Utilities.formatDate(val, 'Asia/Singapore', 'yyyy-MM-dd HH:mm:ss');
      }
      obj[h] = (val !== null && val !== undefined) ? val : '';
    });
    rows.push(obj);
  }

  return rows;
}

// ── ACTION: addNewStop ──────────────────────────────────────────
// Appends a new stop to Uni_BS if not already present.
// Called after driver successfully completes a measurement with a new stop.
function actionAddNewStop(ss, p) {
  var code = String(p.BSCode || '').trim();
  if (!code) return { error: 'BSCode required' };

  var tab = ss.getSheetByName(TAB_BS);
  if (!tab) return { error: 'Uni_BS tab not found' };

  // Check if code already exists — skip if so
  var lastRow = tab.getLastRow();
  if (lastRow >= 2) {
    var codes = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < codes.length; i++) {
      if (String(codes[i][0]).trim() === code) {
        return { status: 'exists', message: code + ' already in Uni_BS' };
      }
    }
  }

  // Append new row: BSCode, BSName, Planned_Lat, Planned_Long, BFC Marker ID, Source
  tab.appendRow([
    code,
    String(p.BSName   || ('NEW - ' + code)),
    parseFloat(p.Planned_Lat)  || '',
    parseFloat(p.Planned_Long) || '',
    '',           // BFC Marker ID — blank for new stops
    String(p.Source || 'DRIVER')
  ]);

  Logger.log('New stop added to Uni_BS: ' + code);
  return { status: 'added', code: code, row: tab.getLastRow() };
}

// ── ACTION: addNewLink ───────────────────────────────────────────
// Appends a new link to Uni_Links if not already present.
function actionAddNewLink(ss, p) {
  var linkId = String(p.Link || (p.FromStopCode + '-' + p.ToStopCode) || '').trim();
  if (!linkId) return { error: 'Link ID required' };

  var tab = ss.getSheetByName(TAB_LINKS);
  if (!tab) return { error: 'Uni_Links tab not found' };

  // Check if link already exists
  var lastRow = tab.getLastRow();
  if (lastRow >= 2) {
    var links = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < links.length; i++) {
      if (String(links[i][0]).trim() === linkId) {
        return { status: 'exists', message: linkId + ' already in Uni_Links' };
      }
    }
  }

  // Append: Link, FromStopCode, ToStopCode, Service, Source
  tab.appendRow([
    linkId,
    String(p.FromStopCode || p.FromStop || '').trim(),
    String(p.ToStopCode   || p.ToStop   || '').trim(),
    String(p.Service      || ''),
    String(p.Source       || 'DRIVER')
  ]);

  Logger.log('New link added to Uni_Links: ' + linkId);
  return { status: 'added', link: linkId, row: tab.getLastRow() };
}

// ── TEST HELPERS (run from Apps Script editor) ───────────────────

function testPing() {
  var e = { parameter: { action: 'ping', callback: '' } };
  var r = doGet(e);
  Logger.log(r.getContent());
}

function testGetReference() {
  var ss   = getSheet();
  var ref  = actionGetReference(ss);
  Logger.log('Stops: ' + ref.stops.length + ' | Links: ' + ref.links.length);
  if (ref.stops.length > 0) Logger.log('First stop: ' + JSON.stringify(ref.stops[0]));
  if (ref.links.length > 0) Logger.log('First link: ' + JSON.stringify(ref.links[0]));
}

function testSaveResult() {
  var ss = getSheet();
  var r  = actionSaveResult(ss, {
    Zone: '1', Run: '1', LinkID: '26419-26429', Service: '65',
    From: '26419', To: '26429',
    PlannedStartLat: '1.3521', PlannedStartLng: '103.8198',
    ActualStartLat:  '1.3522', ActualStartLng:  '103.8199',
    StartFlag: 'AT_STOP',
    PlannedEndLat:   '1.3600', PlannedEndLng:   '103.8250',
    ActualEndLat:    '1.3601', ActualEndLng:    '103.8251',
    EndFlag: 'AT_STOP',
    GPSDist: '0.8240', RouteDist: '0.9100',
    DateTime: '2026-03-22 14:30:00',
    User: 'TEST_DRIVER', Remarks: 'Test row — delete me'
  });
  Logger.log(JSON.stringify(r));
}

function testGetResults() {
  var ss   = getSheet();
  var res  = actionGetResults(ss, {});
  Logger.log('Total rows: ' + res.results.length);
}

function cleanTestRows() {
  // Remove rows where User = 'TEST_DRIVER'
  var ss  = getSheet();
  var tab = ss.getSheetByName(TAB_RESULT);
  if (!tab) return;
  var data = tab.getDataRange().getValues();
  var userCol = data[0].indexOf('User');
  if (userCol < 0) return;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][userCol]).trim() === 'TEST_DRIVER') {
      tab.deleteRow(i + 1);
    }
  }
  Logger.log('Test rows cleaned');
}
