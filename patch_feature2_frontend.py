#!/usr/bin/env python3
"""
Feature 2: index.html frontend changes
1. Add ahChartArea div after ahSummaryCards in HTML
2. Add chart rendering code in renderAIHints after stat cards
"""

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# ============================================================
# 1. Add ahChartArea div in HTML after ahSummaryCards
# ============================================================
old_html = '        <!-- Summary cards -->\n        <div id="ahSummaryCards" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px"></div>\n        <!-- Recommendations -->'

new_html = '        <!-- Summary cards -->\n        <div id="ahSummaryCards" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px"></div>\n        <!-- Daily chart -->\n        <div id="ahChartArea" style="display:none;background:#fff;border:1px solid #e6e8ea;border-radius:8px;padding:20px;margin-bottom:16px"></div>\n        <!-- Recommendations -->'

if old_html not in content:
    print('ERROR: HTML ahSummaryCards anchor not found!')
    exit(1)

content = content.replace(old_html, new_html, 1)
print('HTML ahChartArea div inserted OK')

# ============================================================
# 2. Add chart rendering code in renderAIHints after stat cards block
# We insert after the line that sets ahSummaryCards.innerHTML
# The block ends with the closing backtick of the template literal
# ============================================================

# Find the point after ahSummaryCards innerHTML is set
# It ends with: `    <div style="...">Total Profit...</div>\``;
# We'll look for the end of the summary cards innerHTML and insert after

old_js = """  // Recommendations with color coding"""

new_js = """  // Daily trend chart
  const chartDiv = document.getElementById('ahChartArea');
  if (isCampaignMode && s.dailyData && s.dailyData.length > 1) {
    chartDiv.style.display = 'block';
    chartDiv.innerHTML = '<div style="font-weight:700;font-size:14px;margin-bottom:12px">📈 Daily Trend</div><canvas id="ahCampChart" height="180"></canvas>';
    if (window.ahChart) window.ahChart.destroy();
    window.ahChart = new Chart(document.getElementById('ahCampChart'), {
      type: 'line',
      data: {
        labels: s.dailyData.map(d => d.date.slice(5)),
        datasets: [
          { label: 'Spend €', data: s.dailyData.map(d => d.spend), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
          { label: 'Purchases', data: s.dailyData.map(d => d.purchases), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3, yAxisID: 'y1' }
        ]
      },
      options: { responsive: true, scales: { y: { beginAtZero: true }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } }
    });
  } else { chartDiv.style.display = 'none'; }

  // Recommendations with color coding"""

if old_js not in content:
    print('ERROR: JS renderAIHints anchor not found!')
    exit(1)

content = content.replace(old_js, new_js, 1)
print('JS chart rendering inserted OK')

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done! Feature 2 frontend complete.')
