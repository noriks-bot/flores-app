// NORIKS CAMPAIGN CREATION - SAMO NORIKS PAGE
class NoriksCampaignManager {
  constructor() {
    this.baseUrl = 'https://graph.facebook.com/v21.0';
    
    // SAMO 2 NORIKS AD ACCOUNTS
    this.accounts = {
      'top_noriks_2': 'act_1922887421998222',
      'top_noriks_4': 'act_1426869489183439'
    };
    
    // SAMO NORIKS PAGE
    this.noriksPage = {
      id: '104695358812961',
      name: 'Noriks',
      token: 'EAASl5P6z0UYBRBeMx5auFDmvdkLwZCm8AZAsaVWqcNvyTFZAZBggUFybXpimvtfceKJIjPijA0prRvgWBILLBtdANqShzEmf8PxVCR9Dg5ZACR8Xsx2ucpO19HNktZCbSCK68rd7shT4ZC1SCZC3WkTNuJysHRqvfHlHuF1WdB5Sd2TNB5fAGvVOfnNNZCFE2ZCPWXJRIaiOAZD'
    };
  }

  // CREATE COMPLETE NORIKS CAMPAIGN
  async createNoriksCompleteCampaign(accountId, campaignData, hasPermission = false) {
    if (!hasPermission) {
      return { error: 'PERMISSION REQUIRED! Use createNoriksCompleteCampaign(accountId, data, true)' };
    }

    try {
      console.log('🎯 Creating campaign on NORIKS page only...');

      // 1. CREATE CAMPAIGN
      const campaign = await this.createCampaign(accountId, campaignData.campaign);
      if (campaign.error) throw new Error(`Campaign failed: ${campaign.error.message}`);
      console.log('✅ Campaign created:', campaign.id);

      // 2. CREATE ADSET
      const adset = await this.createAdset(campaign.id, campaignData.adset);
      if (adset.error) throw new Error(`Adset failed: ${adset.error.message}`);
      console.log('✅ Adset created:', adset.id);

      // 3. CREATE CREATIVE (Noriks page only)
      const creative = await this.createNoriksCreative(accountId, campaignData.creative);
      if (creative.error) throw new Error(`Creative failed: ${creative.error.message}`);
      console.log('✅ Creative created:', creative.id);

      // 4. CREATE AD
      const ad = await this.createAd(adset.id, creative.id);
      if (ad.error) throw new Error(`Ad failed: ${ad.error.message}`);
      console.log('✅ Ad created:', ad.id);

      return {
        success: true,
        campaign_id: campaign.id,
        adset_id: adset.id,
        creative_id: creative.id,
        ad_id: ad.id,
        page_used: 'Noriks'
      };

    } catch (error) {
      console.error('❌ Campaign creation failed:', error);
      return { error: error.message };
    }
  }

  // CREATE CAMPAIGN
  async createCampaign(accountId, campaignData) {
    const endpoint = `${this.baseUrl}/${accountId}/campaigns`;
    const payload = {
      name: campaignData.name,
      objective: campaignData.objective,
      status: campaignData.status || 'PAUSED',
      daily_budget: campaignData.daily_budget * 100,
      access_token: this.noriksPage.token
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    return response.json();
  }

  // CREATE ADSET
  async createAdset(campaignId, adsetData) {
    const endpoint = `${this.baseUrl}/${campaignId}/adsets`;
    const payload = {
      name: adsetData.name,
      optimization_goal: 'COST_PER_RESULT',
      billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: adsetData.daily_budget * 100,
      targeting: adsetData.targeting,
      status: 'PAUSED',
      access_token: this.noriksPage.token
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    return response.json();
  }

  // CREATE CREATIVE - NORIKS PAGE SAMO
  async createNoriksCreative(accountId, creativeData) {
    const endpoint = `${this.baseUrl}/${accountId}/adcreatives`;
    const payload = {
      name: creativeData.name,
      object_story_spec: {
        page_id: this.noriksPage.id, // SEMPRE Noriks page
        link_data: {
          image_url: creativeData.image_url,
          link: creativeData.link_url,
          message: creativeData.primary_text,
          name: creativeData.headline,
          description: creativeData.description,
          call_to_action: {
            type: creativeData.cta_type || 'LEARN_MORE'
          }
        }
      },
      access_token: this.noriksPage.token // Noriks page token
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    return response.json();
  }

  // CREATE AD
  async createAd(adsetId, creativeId) {
    const endpoint = `${this.baseUrl}/${adsetId}/ads`;
    const payload = {
      name: `Noriks_Ad_${Date.now()}`,
      creative: { creative_id: creativeId },
      status: 'PAUSED',
      access_token: this.noriksPage.token
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    return response.json();
  }

  // BULK CREATE MULTIPLE CAMPAIGNS
  async createBulkCampaigns(accountId, campaignTemplates, hasPermission = false) {
    if (!hasPermission) {
      return { error: 'PERMISSION REQUIRED! Use createBulkCampaigns(accountId, templates, true)' };
    }

    const results = [];
    
    for (const template of campaignTemplates) {
      console.log(`\n🎯 Creating campaign: ${template.campaign.name}`);
      
      const result = await this.createNoriksCompleteCampaign(accountId, template, true);
      results.push({
        campaign_name: template.campaign.name,
        ...result
      });
      
      // Rate limiting - wait between creations
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return results;
  }
}

// NORIKS CAMPAIGN TEMPLATES
const noriksTemplates = {
  boxers_hu: {
    campaign: {
      name: "SOFISTAR HU | CBO | sku:BOXERS | date: 27.03.2026",
      objective: "OUTCOME_SALES",
      daily_budget: 50
    },
    adset: {
      name: "Adset HU - LAL 1%",
      daily_budget: 25,
      targeting: {
        geo_locations: { countries: ["HU"] },
        age_min: 25,
        age_max: 55,
        genders: [1]
      }
    },
    creative: {
      name: "Creative - Boxers HU",
      image_url: "https://via.placeholder.com/1080x1080/0066cc/ffffff?text=BOXERS+HU",
      link_url: "https://sofistar.com/boxers-hu",
      primary_text: "Fedezd fel a legkényelmesebb boxerokat! 🔥",
      headline: "Premium boxerok - 50% kedvezmény",
      description: "Rendelj most és takarítsd meg!",
      cta_type: "SHOP_NOW"
    }
  },
  
  shirts_si: {
    campaign: {
      name: "SOFISTAR SI | CBO | sku:SHIRTS | date: 27.03.2026", 
      objective: "OUTCOME_SALES",
      daily_budget: 40
    },
    adset: {
      name: "Adset SI - LAL 1%",
      daily_budget: 20,
      targeting: {
        geo_locations: { countries: ["SI"] },
        age_min: 25,
        age_max: 55,
        genders: [1]
      }
    },
    creative: {
      name: "Creative - Shirts SI",
      image_url: "https://via.placeholder.com/1080x1080/ff6600/ffffff?text=SHIRTS+SI",
      link_url: "https://sofistar.com/shirts-si",
      primary_text: "Odkrijte najbolj stilske majice! 👕",
      headline: "Premium majice - 40% popust",
      description: "Naročite zdaj in prihranite!",
      cta_type: "SHOP_NOW"
    }
  }
};

module.exports = { NoriksCampaignManager, noriksTemplates };

// USAGE:
// const { NoriksCampaignManager, noriksTemplates } = require('./noriks_page_only');
// const manager = new NoriksCampaignManager();
// await manager.createNoriksCompleteCampaign('act_1922887421998222', noriksTemplates.boxers_hu, true);