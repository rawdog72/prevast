// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-invitation.ts
// The old client's generated clan request card (GameUI.invitation): fixed
// top-center, shown to a clan leader while someone is asking to join --
// "CLAN REQUEST", the requester's name, "+N waiting" when more are queued,
// Accept (ACCEPT_TEAM_JOIN) and Decline (which, like the old client, only
// moves on to the next request; the server keeps the applicant listed).
// The same card, to a player with no clan, carries a leader's invitation
// (TEAM_INVITE): Accept sends ACCEPT_TEAM_INVITE, Decline just drops it.

import type { ClanStore } from '../../world/clan-store';

export interface HudInvitationCallbacks {
  onAccept: (guid: number) => void;
  onAcceptInvite?: (clanId: number) => void;
}

export class HudInvitation {
  private mounted = false;
  private root!: HTMLElement;
  private titleEl!: HTMLElement;
  private nameEl!: HTMLElement;
  private subEl!: HTMLElement;
  private waitingEl!: HTMLElement;
  private clans: ClanStore | null = null;
  private lastSignature = '';

  mount(root: HTMLElement, callbacks: HudInvitationCallbacks): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root = root;
    root.hidden = true;
    root.innerHTML =
      '<div class="dv-invite dv-panel">' +
      '<div class="dv-invite-head"><span class="dv-label">Clan request</span><span class="dv-invite-waiting dv-label"></span></div>' +
      '<div class="dv-invite-name"></div>' +
      '<div class="dv-invite-sub dv-muted"></div>' +
      '<div class="dv-invite-actions">' +
      '<button type="button" class="dv-btn is-primary dv-invite-accept">Accept</button>' +
      '<button type="button" class="dv-btn dv-invite-decline">Decline</button>' +
      '</div></div>';
    this.titleEl = root.querySelector('.dv-invite-head .dv-label')!;
    this.nameEl = root.querySelector('.dv-invite-name')!;
    this.subEl = root.querySelector('.dv-invite-sub')!;
    this.waitingEl = root.querySelector('.dv-invite-waiting')!;
    root.querySelector('.dv-invite-accept')!.addEventListener('click', () => {
      const clans = this.clans;
      if (!clans) return;
      if (clans.isLeader && clans.joinRequest !== 0) {
        callbacks.onAccept(clans.joinRequest);
        clans.nextInvitation();
      } else if (clans.invite) {
        callbacks.onAcceptInvite?.(clans.invite.clanId);
        clans.clearInvite();
      }
      this.lastSignature = '';
    });
    root.querySelector('.dv-invite-decline')!.addEventListener('click', () => {
      const clans = this.clans;
      if (clans?.isLeader && clans.joinRequest !== 0) clans.nextInvitation();
      else clans?.clearInvite();
      this.lastSignature = '';
    });
  }

  update(clans: ClanStore): void {
    this.clans = clans;
    const requester =
      clans.isLeader && clans.joinRequest !== 0 ? clans.player(clans.joinRequest) : undefined;
    if (requester) {
      const pending = clans.pendingCount();
      this.show(
        `request:${requester.guid}:${requester.nickname}:${pending}`,
        'Clan request',
        requester.nickname,
        'Wants to join your clan',
        pending > 0 ? `+${pending} waiting` : '',
      );
      return;
    }
    const invite = clans.teamId === -1 ? clans.invite : null;
    const clan = invite ? clans.clan(invite.clanId) : undefined;
    if (invite && clan) {
      const inviter = clans.player(invite.inviterGuid)?.nickname || 'A clan leader';
      this.show(
        `invite:${clan.id}:${clan.name}:${inviter}`,
        'Clan invitation',
        clan.name,
        `${inviter} invites you to join`,
        '',
      );
      return;
    }
    this.root.hidden = true;
    this.lastSignature = '';
  }

  private show(signature: string, title: string, name: string, sub: string, waiting: string): void {
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.root.hidden = false;
    this.titleEl.textContent = title;
    this.nameEl.textContent = name;
    this.subEl.textContent = sub;
    this.waitingEl.textContent = waiting;
  }
}
