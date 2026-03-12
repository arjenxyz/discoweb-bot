// ============================================
// PROFESSIONAL MAIL TEMPLATES (CORPORATE EDITION)
// Both Plain Text and HTML versions
// ============================================

const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// ============================================
// PLAIN TEXT VERSIONS (For Simple Clients)
// ============================================

function renderTagGainedPlainText(userTag, newRatesText) {
  const lines = [];
  
  lines.push('Hesap Durum Güncellemesi: Etiket Doğrulandı');
  lines.push('');
  lines.push(`Sayın ${userTag},`);
  lines.push('');
  lines.push('Kullanıcı adınızdaki sunucu etiketi sistem protokolleri tarafından başarıyla doğrulanmıştır.');
  lines.push('İlgili etiket kullanımına bağlı avantajlar, bonus katsayıları ve ek kazanç oranları hesabınıza tanımlanmıştır.');
  lines.push('');
  lines.push('--- GÜNCEL KAZANÇ ORANLARI ---');
  lines.push('');
  lines.push(newRatesText);
  lines.push('');
  lines.push('Hesabınızdaki yeni ayrıcalıklar anında kullanıma açılmıştır.');

  return lines.join('\n');
}

function renderTagLostPlainText(userTag) {
  const lines = [];
  
  lines.push('Sistem Bildirimi: Etiket Tespiti Başarısız');
  lines.push('');
  lines.push(`Sayın ${userTag},`);
  lines.push('');
  lines.push('Yapılan otomatik sistem kontrollerinde, kullanıcı adınızdaki sunucu etiketinin kaldırıldığı veya değiştirildiği tespit edilmiştir.');
  lines.push('');
  lines.push('Buna bağlı olarak, etiket kaynaklı tüm avantajlarınız, bonus oranlarınız ve ek yetkileriniz güvenlik prosedürleri gereği askıya alınmıştır.');
  lines.push('');
  lines.push('Avantajları yeniden aktif etmek için etiketi tekrar ekleyip doğrulama sağlayabilirsiniz.');

  return lines.join('\n');
}

function renderBoostStartedPlainText(userTag, boostSummaryText) {
  const lines = [];
  
  lines.push('İşlem Onayı: Sunucu Takviyesi Aktif');
  lines.push('');
  lines.push(`Sayın ${userTag},`);
  lines.push('');
  lines.push('Sunucuya sağladığınız takviye (boost) desteği sistem veritabanına işlenmiştir.');
  lines.push('"Booster" statüsü kapsamındaki tüm ayrıcalıklar, ek özellikler ve performans artırıcılar şu an itibarıyla hesabınızda aktiftir.');
  lines.push('');
  lines.push('--- AKTİF EDİLEN HİZMETLER ---');
  lines.push('');
  lines.push(boostSummaryText);
  lines.push('');
  lines.push('Destekleriniz, hizmet kalitesinin sürdürülebilirliği için önem arz etmektedir. Teşekkür ederiz.');

  return lines.join('\n');
}

function renderBoostEndedPlainText(userTag) {
  const lines = [];
  
  lines.push('Hizmet Sonlanması: Takviye Süresi Doldu');
  lines.push('');
  lines.push(`Sayın ${userTag},`);
  lines.push('');
  lines.push('Mevcut sunucu takviyesi süreniz sona ermiştir.');
  lines.push('Takviye avantajları, ek özellikler ve "Booster" statüsü, sistem politikaları gereği hesabınızdan otomatik olarak kaldırılmıştır.');
  lines.push('');
  lines.push('Hizmeti yenilemeniz durumunda tüm ayrıcalıklar tekrar tanımlanacaktır.');

  return lines.join('\n');
}

function renderRoleGainedPlainText(roleName, userTag) {
  const lines = [];
  
  lines.push('Hesap Aktivasyonu: Tam Erişim Onaylandı');
  lines.push('');
  lines.push(`Sayın ${userTag},`);
  lines.push('');
  lines.push(`Hesabınıza tanımlanan "${roleName}" statüsü ile birlikte, web platformundaki tüm finansal araçlara, kazanç sistemlerine ve yönetim panellerine erişim yetkiniz onaylanmıştır.`);
  lines.push('');
  lines.push('Platform üzerindeki tüm kısıtlamalar kaldırılmıştır. İşlemlerinize başlayabilirsiniz.');

  return lines.join('\n');
}

function renderRoleLostPlainText(roleName, userTag) {
  const lines = [];
  
  lines.push('Erişim Kısıtlaması: Hesap Statüsü Değişikliği');
  lines.push('');
  lines.push(`Sayın ${userTag},`);
  lines.push('');
  lines.push(`Hesabınızdaki "${roleName}" statüsünün kaldırılması nedeniyle, web platformuna erişiminiz, kazanç elde etme yetkileriniz ve mağaza işlemleriniz güvenlik protokolleri gereği durdurulmuştur.`);
  lines.push('');
  lines.push('Hizmetlerimizden yararlanmaya devam etmek için doğrulama adımlarını tekrar tamamlamanız gerekmektedir.');

  return lines.join('\n');
}


// ============================================
// HTML VERSIONS (Corporate / SaaS Style)
// ============================================

function renderMailHTML(title, greeting, body, emoji = '📋') {
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #374151; line-height: 1.6; font-size: 14px; max-width: 600px;">
  
  <div style="margin-bottom: 24px; border-bottom: 1px solid #e5e7eb; padding-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <span style="font-size: 20px;">${emoji}</span>
      <h1 style="margin: 0; font-size: 18px; font-weight: 600; color: #111827; letter-spacing: -0.025em;">${esc(title)}</h1>
    </div>
  </div>

  <div style="margin-bottom: 24px;">
    <p style="margin: 0 0 16px 0; color: #111827; font-weight: 500;">${greeting}</p>
    ${body}
  </div>
  
  <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
    Bu bildirim otomatik sistem protokolleri tarafından oluşturulmuştur. Lütfen cevaplamayınız.
  </div>
</div>
  `.trim();
}

function renderTagGainedHTML(userTag, newRatesHTML) {
  const greeting = `Sayın ${esc(userTag)},`;
  const body = `
    <p style="margin: 0 0 16px 0;">
      Kullanıcı adınızdaki sunucu etiketi sistem protokolleri tarafından başarıyla doğrulanmıştır. İlgili etiket kullanımına bağlı <strong>avantajlar, bonus katsayıları ve ek kazanç oranları</strong> hesabınıza tanımlanmıştır.
    </p>
    
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #475569;">
        📋 Güncel Kazanç Oranları
      </h3>
      <div style="color: #334155; font-size: 14px;">
        ${newRatesHTML}
      </div>
    </div>
    
    <p style="margin: 0; color: #4b5563;">
      Hesabınızdaki yeni ayrıcalıklar anında kullanıma açılmıştır.
    </p>
  `;
  
  return renderMailHTML('Hesap Durum Güncellemesi: Etiket Doğrulandı', greeting, body, '✅');
}

function renderTagLostHTML(userTag) {
  const greeting = `Sayın ${esc(userTag)},`;
  const body = `
    <p style="margin: 0 0 16px 0;">
      Yapılan otomatik sistem kontrollerinde, kullanıcı adınızdaki sunucu etiketinin <strong>kaldırıldığı veya değiştirildiği</strong> tespit edilmiştir.
    </p>
    
    <div style="background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #be123c;">
        ⚠️ <strong>Durum Bildirimi:</strong> Etiket kaynaklı tüm avantajlarınız, bonus oranlarınız ve ek yetkileriniz güvenlik prosedürleri gereği askıya alınmıştır.
      </p>
    </div>

    <p style="margin: 0; color: #4b5563;">
      Avantajları yeniden aktif etmek için etiketi tekrar ekleyip doğrulama sağlayabilirsiniz.
    </p>
  `;
  
  return renderMailHTML('Sistem Bildirimi: Etiket Tespiti Başarısız', greeting, body, '🚫');
}

function renderBoostStartedHTML(userTag, boostSummaryHTML) {
  const greeting = `Sayın ${esc(userTag)},`;
  const body = `
    <p style="margin: 0 0 16px 0;">
      Sunucuya sağladığınız takviye (boost) desteği sistem veritabanına işlenmiştir. "Booster" statüsü kapsamındaki tüm ayrıcalıklar ve ek özellikler şu an itibarıyla hesabınızda aktiftir.
    </p>
    
    <div style="background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #5b21b6;">
        🚀 Aktif Edilen Hizmetler
      </h3>
      <div style="color: #4c1d95; font-size: 14px;">
        ${boostSummaryHTML}
      </div>
    </div>
    
    <p style="margin: 0; color: #4b5563;">
      Destekleriniz, hizmet kalitesinin sürdürülebilirliği için önem arz etmektedir. Teşekkür ederiz.
    </p>
  `;
  
  return renderMailHTML('İşlem Onayı: Sunucu Takviyesi Aktif', greeting, body, '💎');
}

function renderBoostEndedHTML(userTag) {
  const greeting = `Sayın ${esc(userTag)},`;
  const body = `
    <p style="margin: 0 0 16px 0;">
      Mevcut sunucu takviyesi süreniz sona ermiştir.
    </p>
    
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #92400e;">
        ⏳ <strong>Hizmet Durumu:</strong> Takviye avantajları, ek özellikler ve "Booster" statüsü, sistem politikaları gereği hesabınızdan otomatik olarak kaldırılmıştır.
      </p>
    </div>
    
    <p style="margin: 0; color: #4b5563;">
      Hizmeti yenilemeniz durumunda tüm ayrıcalıklar tekrar tanımlanacaktır.
    </p>
  `;
  
  return renderMailHTML('Hizmet Sonlanması: Takviye Süresi Doldu', greeting, body, '⌛');
}

function renderRoleGainedHTML(roleName, userTag) {
  const greeting = `Sayın ${esc(userTag)},`;
  const body = `
    <p style="margin: 0 0 16px 0;">
      Hesabınıza tanımlanan <strong>"${esc(roleName)}"</strong> statüsü ile birlikte, web platformundaki tüm finansal araçlara, kazanç sistemlerine ve yönetim panellerine erişim yetkiniz onaylanmıştır.
    </p>
    
    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; color: #166534;">
        ✅ Erişim Yetkisi Verildi
      </h3>
      <p style="margin: 0; font-size: 14px; color: #15803d;">
        Platform üzerindeki tüm kısıtlamalar kaldırılmıştır. İşlemlerinize başlayabilirsiniz.
      </p>
    </div>
  `;
  
  return renderMailHTML('Hesap Aktivasyonu: Tam Erişim Onaylandı', greeting, body, '🔓');
}

function renderRoleLostHTML(roleName, userTag) {
  const greeting = `Sayın ${esc(userTag)},`;
  const body = `
    <p style="margin: 0 0 16px 0;">
      Hesabınızdaki <strong>"${esc(roleName)}"</strong> statüsünün kaldırılması nedeniyle hesap yetkilerinizde değişiklik yapılmıştır.
    </p>
    
    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; color: #991b1b;">
        ⛔ Erişim Durduruldu
      </h3>
      <p style="margin: 0; font-size: 14px; color: #7f1d1d;">
        Güvenlik protokolleri gereği; web platformuna erişiminiz, kazanç elde etme yetkileriniz ve mağaza işlemleriniz <strong>geçici olarak askıya alınmıştır.</strong>
      </p>
    </div>

    <p style="margin: 0; color: #4b5563;">
      Hizmetlerimizden yararlanmaya devam etmek için doğrulama adımlarını tekrar tamamlamanız gerekmektedir.
    </p>
  `;
  
  return renderMailHTML('Erişim Kısıtlaması: Hesap Statüsü Değişikliği', greeting, body, '🔒');
}


// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Plain Text
  renderTagGainedPlainText,
  renderTagLostPlainText,
  renderBoostStartedPlainText,
  renderBoostEndedPlainText,
  renderRoleGainedPlainText,
  renderRoleLostPlainText,
  
  // HTML
  renderTagGainedHTML,
  renderTagLostHTML,
  renderBoostStartedHTML,
  renderBoostEndedHTML,
  renderRoleGainedHTML,
  renderRoleLostHTML,
  
  // Legacy aliases
  renderTagGained: renderTagGainedHTML,
  renderTagLost: renderTagLostHTML,
  renderBoostStarted: renderBoostStartedHTML,
  renderBoostEnded: renderBoostEndedHTML,
  renderRoleGained: renderRoleGainedHTML,
  renderRoleLost: renderRoleLostHTML,
};