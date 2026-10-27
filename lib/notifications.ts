import type { BureauDatabase, SqlStatement } from "./bureau-api";

/** Outbox insertion is part of the same DB batch as the successful domain change. */
export function accessRequestNotification(db: BureauDatabase, userId: string, eventId: string, recipient: string, now: string): SqlStatement {
  return db.prepare(`INSERT INTO notification_outbox (id,event_key,recipient_user_id,recipient_email,subject,body_text,status,attempts,created_at,updated_at)
    SELECT 'access-request:'||r.request_event_id,'access-request:'||r.request_event_id,NULL,?,
      'Nouvelle demande d’accès au cercle créatif EMBRASSE',
      r.name||' demande un accès au cercle créatif EMBRASSE.'||char(10)||'Adresse vérifiée : '||r.email||char(10)||'Message : '||r.reason||char(10)||char(10)||'Pour approuver ou refuser cette demande, connectez-vous sur https://abonnement.embrasse.tv/ avec votre compte responsable. La réception de ce message ne valide aucun accès.',
      'pending',0,?,?
    FROM site_access_requests r WHERE r.user_id=? AND r.request_event_id=? AND r.status='pending'
    ON CONFLICT(event_key) DO NOTHING`).bind(recipient,now,now,userId,eventId);
}


/** Must immediately follow the conditional decision UPDATE in one DB batch. */
export function accessDecisionNotification(db: BureauDatabase, userId: string, status: "approved" | "rejected", adminId: string, now: string): SqlStatement {
  const subject=status==="approved"?"Votre accès au cercle créatif EMBRASSE est approuvé":"Votre demande d’accès au cercle créatif EMBRASSE";
  const body=status==="approved"?"Votre demande d’accès au cercle créatif EMBRASSE a été approuvée. Connectez-vous avec le même compte sur https://abonnement.embrasse.tv/ pour retrouver les abonnements du cercle.":"Votre demande d’accès au cercle créatif EMBRASSE n’a pas été approuvée. Vous pouvez contacter le responsable ou déposer une nouvelle demande sur https://abonnement.embrasse.tv/ si nécessaire.";
  return db.prepare(`INSERT INTO notification_outbox (id,event_key,recipient_user_id,recipient_email,subject,body_text,status,attempts,created_at,updated_at)
    SELECT 'access-decision:'||r.request_event_id||':'||r.status,'access-decision:'||r.request_event_id||':'||r.status,r.user_id,r.email,?,?,
      'pending',0,?,?
    FROM site_access_requests r WHERE r.user_id=? AND r.status=? AND r.decided_by=? AND r.updated_at=? AND changes()=1
    ON CONFLICT(event_key) DO NOTHING`).bind(subject,body,now,now,userId,status,adminId,now);
}

/** Snapshot all recipients and exact cent shares atomically after the member is admitted. */
export function joinedSubscriptionNotifications(db: BureauDatabase, subscriptionId: string, newUserId: string, eventId: string, now: string): SqlStatement {
  return db.prepare(`INSERT INTO notification_outbox (id,event_key,recipient_user_id,recipient_email,subject,body_text,status,attempts,created_at,updated_at)
    WITH active AS (
      SELECT sm.user_id,p.email,p.notifications_enabled,
        ROW_NUMBER() OVER (ORDER BY sm.user_id)-1 AS rank,
        COUNT(*) OVER () AS participant_count
      FROM subscription_members sm JOIN profiles p ON p.id=sm.user_id
      JOIN workspace_members wm ON wm.workspace_id=(SELECT workspace_id FROM subscriptions WHERE id=?) AND wm.user_id=sm.user_id
      WHERE sm.subscription_id=? AND sm.status='active' AND (sm.cancellation_effective_at IS NULL OR sm.cancellation_effective_at>?)
    )
    SELECT 'subscription-joined:'||?||':'||a.user_id,'subscription-joined:'||?||':'||a.user_id,a.user_id,a.email,
      'Un nouveau membre dans votre abonnement partagé',
      entrant.name||' a été accepté dans l’abonnement « '||s.name||' ».'||char(10)||
      'Le groupe compte maintenant '||a.participant_count||' personne(s).'||char(10)||
      'Votre part prévisionnelle est de '||printf('%.2f',(CAST(s.total_cents/a.participant_count AS INTEGER)+CASE WHEN a.rank<(s.total_cents%a.participant_count) THEN 1 ELSE 0 END)/100.0)||' EUR par mois.'||char(10)||
      'Cette estimation reflète les participants actuels. Les périodes déjà arrêtées restent inchangées ; le montant effectivement demandé suit le cycle de cotisation et votre autorisation.'||char(10)||
      'Retrouvez votre abonnement sur https://abonnement.embrasse.tv/',
      'pending',0,?,?
    FROM active a JOIN subscriptions s ON s.id=? JOIN profiles entrant ON entrant.id=?
    WHERE a.notifications_enabled=1 AND EXISTS(SELECT 1 FROM subscription_members admitted WHERE admitted.subscription_id=s.id AND admitted.user_id=? AND admitted.status='active' AND admitted.approval_event_id=?)
    ON CONFLICT(event_key) DO NOTHING`).bind(subscriptionId,subscriptionId,now,eventId,eventId,now,now,subscriptionId,newUserId,newUserId,eventId);
}
