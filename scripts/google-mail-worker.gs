// À installer dans un projet Google Apps Script du compte expéditeur autorisé.
const BUREAU_SITE = 'https://votre-domaine.example'; // À remplacer par votre propre site HTTPS.

function connexionGoogle() {
  const token = ScriptApp.getIdentityToken();
  if (!token) throw new Error('Autorisation Google nécessaire.');
  const claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString());
  // L’audience et l’email sont des paramètres de raccordement, jamais le jeton.
  console.log('Adresse Google : ' + claims.email);
  console.log('Audience à raccorder : ' + claims.aud);
  console.log('Quota d’envoi restant : ' + MailApp.getRemainingDailyQuota());
}

function installerLesNotifications() {
  connexionGoogle();
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'envoyerLesNotifications');
  if (!triggers.length) ScriptApp.newTrigger('envoyerLesNotifications').timeBased().everyMinutes(1).create();
  console.log('Vérification des notifications toutes les minutes.');
}

function arreterLesNotifications() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'envoyerLesNotifications').forEach(t => ScriptApp.deleteTrigger(t));
}

function envoyerLesNotifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    for (let i = 0; i < 10; i++) {
      if (MailApp.getRemainingDailyQuota() < 1) return;
      const jobs = appelerLeBureau_('jobs', {}).jobs;
      if (!jobs.length) return;
      const job = jobs[0]; // Une seule réservation : un incident ne bloque pas les autres messages.
      let outcome = 'uncertain';
      try {
        if (!/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(job.to)) throw new Error('Destinataire invalide.');
        MailApp.sendEmail({to:job.to,subject:job.subject,body:job.text,name:'Le cercle EMBRASSE'});
        outcome = 'sent'; // Accepté par Google, pas une garantie d’arrivée en boîte de réception.
      } catch (error) {
        console.warn('Un envoi reste à vérifier. Référence : ' + job.id);
      }
      appelerLeBureau_('ack', {id:job.id,leaseToken:job.leaseToken,outcome:outcome});
    }
  } finally { lock.releaseLock(); }
}

function appelerLeBureau_(action, data) {
  const token = ScriptApp.getIdentityToken();
  if (!token) throw new Error('Autorisation Google nécessaire.');
  const response = UrlFetchApp.fetch(BUREAU_SITE + '/api/notifications/' + action, {
    method:'post',contentType:'application/json',payload:JSON.stringify(data),
    headers:{Authorization:'Bearer ' + token},muteHttpExceptions:true,followRedirects:false
  });
  if (response.getResponseCode() !== 200) throw new Error('Le bureau demande de vérifier le raccordement email (HTTP ' + response.getResponseCode() + ').');
  return JSON.parse(response.getContentText());
}
