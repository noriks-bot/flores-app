#!/usr/bin/env python3
"""
Feature 1: Add "Creatives waiting for CZ" table in Upload section
- HTML: add after #uploadTable div
- JS: add at end of generateUploadPlan, before the catch
"""

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# ============================================================
# 1. Insert HTML after the closing </div> of #uploadTable
# ============================================================
old_html = '''      <div id="uploadTable" style="display:none">
        <div class="table-card">
          <div style="padding:14px 18px;font-weight:700;font-size:14px;border-bottom:1px solid var(--border-color)">📋 Expansion Opportunities</div>
          <div class="table-scroll" style="max-height:calc(100vh - 320px)">
            <table class="cr-table">
              <thead><tr>
                <th class="cr-th" style="text-align:left">Creative ID</th>
                <th class="cr-th">Total Spend</th>
                <th class="cr-th">Purchases</th>
                <th class="cr-th">Overall CPA</th>
                <th class="cr-th" style="text-align:left">Winning in</th>
                <th class="cr-th">Best CPA</th>
                <th class="cr-th" style="text-align:left">Expand to</th>
                <th class="cr-th">Priority</th>
              </tr></thead>
              <tbody id="uploadBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ORIGIN REPORT -->'''

new_html = '''      <div id="uploadTable" style="display:none">
        <div class="table-card">
          <div style="padding:14px 18px;font-weight:700;font-size:14px;border-bottom:1px solid var(--border-color)">📋 Expansion Opportunities</div>
          <div class="table-scroll" style="max-height:calc(100vh - 320px)">
            <table class="cr-table">
              <thead><tr>
                <th class="cr-th" style="text-align:left">Creative ID</th>
                <th class="cr-th">Total Spend</th>
                <th class="cr-th">Purchases</th>
                <th class="cr-th">Overall CPA</th>
                <th class="cr-th" style="text-align:left">Winning in</th>
                <th class="cr-th">Best CPA</th>
                <th class="cr-th" style="text-align:left">Expand to</th>
                <th class="cr-th">Priority</th>
              </tr></thead>
              <tbody id="uploadBody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div id="uploadWaitingTable" style="display:none;margin-top:16px">
        <div class="table-card">
          <div style="padding:14px 18px;font-weight:700;font-size:14px;border-bottom:1px solid #e6e8ea">
            <span style="margin-right:8px">🇨🇿</span> Creatives waiting for CZ
            <span id="waitingCZCount" style="font-size:11px;color:#9ca3af;margin-left:8px"></span>
          </div>
          <div class="table-scroll" style="max-height:400px">
            <table class="cr-table">
              <thead><tr>
                <th class="cr-th" style="text-align:left">Creative ID</th>
                <th class="cr-th">Best Country</th>
                <th class="cr-th">Best CPA</th>
                <th class="cr-th">Spend (other)</th>
                <th class="cr-th">CZ Spend</th>
                <th class="cr-th">Status</th>
              </tr></thead>
              <tbody id="waitingCZBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ORIGIN REPORT -->'''

if old_html not in content:
    print('ERROR: HTML anchor not found!')
    exit(1)

content = content.replace(old_html, new_html, 1)
print('HTML inserted OK')

# ============================================================
# 2. Insert JS at end of generateUploadPlan, before the catch
# Find: the last block that sets uploadTable.style.display='block'
# Then find the next `} catch` after it and insert before
# ============================================================

# The generateUploadPlan function ends with something like:
#   document.getElementById('uploadTable').style.display='block';
# followed by `} catch (e) {`

js_anchor = "      document.getElementById('uploadTable').style.display='block';\n    }\n  } catch(e) {"

js_new = """      document.getElementById('uploadTable').style.display='block';

      // Creatives waiting for CZ
      const FLAGS = {HR:'🇭🇷',CZ:'🇨🇿',PL:'🇵🇱',GR:'🇬🇷',SK:'🇸🇰',IT:'🇮🇹',HU:'🇭🇺'};
      const waitingCZ = [];
      for (const cr of data.creatives) {
        if (cr.id === 'Other') continue;
        const czSpend = cr.countries['CZ']?.spend || 0;
        if (czSpend >= 15) continue; // already tested in CZ
        // Find best performing country
        let bestCC = null, bestCPA = Infinity, bestSpend = 0;
        for (const cc of ['HR','GR','HU','SK','IT','PL']) {
          const cs = cr.countries[cc];
          if (cs && cs.spend > 15 && cs.purchases > 0) {
            const cpa = cs.spend / cs.purchases;
            if (cpa < bestCPA) { bestCC = cc; bestCPA = cpa; bestSpend = cs.spend; }
          }
        }
        if (!bestCC) continue;
        waitingCZ.push({ id: cr.id, bestCC, bestCPA, bestSpend, czSpend, adCount: cr.adCount });
      }
      waitingCZ.sort((a, b) => a.bestCPA - b.bestCPA);

      if (waitingCZ.length > 0) {
        document.getElementById('waitingCZCount').textContent = waitingCZ.length + ' creatives';
        document.getElementById('waitingCZBody').innerHTML = waitingCZ.map(w => {
          const cpaStyle = w.bestCPA <= 15 ? 'background:#4caf50;color:#fff;font-weight:600' : w.bestCPA <= 20 ? 'background:#84cc16;color:#fff;font-weight:600' : 'background:#f59e0b;color:#fff;font-weight:600';
          const status = w.czSpend === 0 ? '<span style="color:#ef4444;font-weight:600">Not tested</span>' : '<span style="color:#f59e0b">Low spend (' + w.czSpend.toFixed(0) + '€)</span>';
          return '<tr>' +
            '<td style="text-align:left;font-weight:700">' + w.id + ' <span style="font-size:10px;color:#9ca3af">' + w.adCount + ' ads</span></td>' +
            '<td>' + (FLAGS[w.bestCC]||'') + ' ' + w.bestCC + '</td>' +
            '<td style="' + cpaStyle + ';padding:4px 8px;border-radius:3px">' + w.bestCPA.toFixed(2) + ' €</td>' +
            '<td style="font-weight:600">' + w.bestSpend.toFixed(0) + ' €</td>' +
            '<td>' + (w.czSpend > 0 ? w.czSpend.toFixed(2) + ' €' : '—') + '</td>' +
            '<td>' + status + '</td>' +
          '</tr>';
        }).join('');
        document.getElementById('uploadWaitingTable').style.display = 'block';
      } else {
        document.getElementById('uploadWaitingTable').style.display = 'none';
      }
    }
  } catch(e) {"""

if js_anchor not in content:
    print('ERROR: JS anchor not found!')
    # Try to find what's there
    idx = content.find("uploadTable").split
    exit(1)

content = content.replace(js_anchor, js_new, 1)
print('JS inserted OK')

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done! Feature 1 complete.')
