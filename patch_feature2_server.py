#!/usr/bin/env python3
"""
Feature 2: server.js - add dailyData to /api/ai-hints campaign response
"""

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the return sendJSON in campaign mode and add dailyData before it
old_code = '''          return sendJSON(res, {
            summary: {
              campaignName: campaign.name,
              campaignId: campaign.id,
              campaignStatus: campaign.status,
              totalSpend: Math.round(spend * 100) / 100,
              totalOrders: orders,
              totalProfit: Math.round(profit * 100) / 100,
              avgCPA: cpa,
              totalPurchases: purch,
              adsets: adsetList,
              recommendations,
              dateRange: { start: aiStart, end: aiEnd }
            }
          });'''

new_code = '''          // Daily breakdown
          let dailyData = [];
          try {
            const dailyInsights = await metaGetAll(campaign.id + '/insights', {
              fields: 'spend,actions',
              time_range: JSON.stringify({ since: aiStart, until: aiEnd }),
              time_increment: 1
            });
            dailyData = dailyInsights.map(d => ({
              date: d.date_start,
              spend: parseFloat(d.spend || 0),
              purchases: ((d.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase')?.value || 0) * 1
            }));
          } catch(e) { console.error('Daily insights error:', e.message); }

          return sendJSON(res, {
            summary: {
              campaignName: campaign.name,
              campaignId: campaign.id,
              campaignStatus: campaign.status,
              totalSpend: Math.round(spend * 100) / 100,
              totalOrders: orders,
              totalProfit: Math.round(profit * 100) / 100,
              avgCPA: cpa,
              totalPurchases: purch,
              adsets: adsetList,
              recommendations,
              dailyData,
              dateRange: { start: aiStart, end: aiEnd }
            }
          });'''

if old_code not in content:
    print('ERROR: server.js anchor not found!')
    exit(1)

content = content.replace(old_code, new_code, 1)
print('server.js patched OK')

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done! server.js feature 2 complete.')
