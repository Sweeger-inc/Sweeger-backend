const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const BANNERS = {
  followed: 'People you follow are already watching, so we grouped you with them.',
  matched: 'No one you follow is here yet, so we randomly matched you with others new to Sweeger.',
};

// Core matching function (PRD v7 section 4.2):
// 1. If someone the user follows is in an active pod with space, place them there.
// 2. Otherwise match preferring people new to Sweeger and sharing interests.
// 3. First person into a fresh group becomes its admin; cap 12 per pod.
const assignUserToPod = async (roomId, userId) => {
  const { data: followingData } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId);

  const followingIds = followingData?.map((f) => f.following_id) || [];

  const { data: userCategories } = await supabase
    .from('user_categories')
    .select('category')
    .eq('user_id', userId);

  const myInterests = new Set((userCategories || []).map((c) => c.category));

  const { data: pods } = await supabase
    .from('watch_mate_pods')
    .select(`
      id,
      member_count,
      capacity,
      watch_mate_members (
        user_id
      )
    `)
    .eq('room_id', roomId)
    .lt('member_count', 12)
    .order('created_at', { ascending: true });

  let assignedPodId = null;
  let matchReason = 'matched';

  if (pods && pods.length > 0) {
    // 1. Prioritize pod containing followed users
    let bestFollowPod = null;
    let bestFollowScore = 0;

    for (const pod of pods) {
      const memberIds = (pod.watch_mate_members || []).map((m) => m.user_id);
      const followsInPod = memberIds.filter((id) => followingIds.includes(id));

      if (followsInPod.length > bestFollowScore) {
        bestFollowScore = followsInPod.length;
        bestFollowPod = pod;
      }
    }

    if (bestFollowPod) {
      assignedPodId = bestFollowPod.id;
      matchReason = 'followed';
    } else {
      // 2. Score remaining pods by shared interests and newer platform members
      const allMemberIds = [
        ...new Set(pods.flatMap((p) => (p.watch_mate_members || []).map((m) => m.user_id))),
      ];

      let memberCategoriesMap = new Map();
      let newUsersSet = new Set();

      if (allMemberIds.length > 0) {
        const [{ data: memberCats }, { data: memberUsers }] = await Promise.all([
          supabase.from('user_categories').select('user_id, category').in('user_id', allMemberIds),
          supabase.from('users').select('id, created_at').in('id', allMemberIds),
        ]);

        for (const mc of memberCats || []) {
          if (!memberCategoriesMap.has(mc.user_id)) memberCategoriesMap.set(mc.user_id, []);
          memberCategoriesMap.get(mc.user_id).push(mc.category);
        }

        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const u of memberUsers || []) {
          if (u.created_at && new Date(u.created_at).getTime() >= thirtyDaysAgo) {
            newUsersSet.add(u.id);
          }
        }
      }

      let bestAffinityPod = pods[0];
      let bestAffinityScore = -1;

      for (const pod of pods) {
        const memberIds = (pod.watch_mate_members || []).map((m) => m.user_id);
        let score = 0;
        for (const mid of memberIds) {
          if (newUsersSet.has(mid)) score += 2;
          const cats = memberCategoriesMap.get(mid) || [];
          for (const c of cats) {
            if (myInterests.has(c)) score += 3;
          }
        }
        if (score > bestAffinityScore) {
          bestAffinityScore = score;
          bestAffinityPod = pod;
        }
      }

      assignedPodId = bestAffinityPod.id;
      matchReason = 'matched';
    }
  }

  // Create new pod if none available
  if (!assignedPodId) {
    const { data: newPod } = await supabase
      .from('watch_mate_pods')
      .insert({ room_id: roomId, capacity: 12, member_count: 0 })
      .select()
      .single();

    assignedPodId = newPod.id;
    matchReason = 'matched';
  }

  await supabase
    .from('watch_mate_members')
    .upsert(
      {
        pod_id: assignedPodId,
        user_id: userId,
        room_id: roomId,
        is_active: true,
        is_admin: false,
        match_reason: matchReason,
      },
      { onConflict: 'pod_id,user_id' }
    );

  const { count } = await supabase
    .from('watch_mate_members')
    .select('*', { count: 'exact', head: true })
    .eq('pod_id', assignedPodId)
    .eq('is_active', true);

  if (count === 1) {
    await supabase
      .from('watch_mate_members')
      .update({ is_admin: true })
      .eq('pod_id', assignedPodId)
      .eq('user_id', userId);
  }

  await supabase
    .from('watch_mate_pods')
    .update({ member_count: count || 1 })
    .eq('id', assignedPodId);

  return {
    podId: assignedPodId,
    matchReason,
    banner: BANNERS[matchReason] || BANNERS.matched,
  };
};

// POST /api/watchmate/:roomId/join — assign user to a watch mate pod
router.post('/:roomId/join', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth.userId;

    const { data: existing } = await supabase
      .from('watch_mate_members')
      .select('pod_id, match_reason')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (existing) {
      const reason = existing.match_reason || 'matched';
      return res.status(200).json({
        message: 'Already in a Watch Mate pod',
        pod_id: existing.pod_id,
        match_reason: reason,
        banner: BANNERS[reason] || BANNERS.matched,
      });
    }

    const { podId, matchReason, banner } = await assignUserToPod(roomId, userId);

    return res.status(200).json({
      message: 'Assigned to Watch Mate pod',
      pod_id: podId,
      match_reason: matchReason,
      banner,
    });
  } catch (err) {
    console.error('Watch Mate join error:', err.message);
    return res.status(500).json({ error: 'Failed to assign Watch Mate pod' });
  }
});

// GET /api/watchmate/:roomId/pod — get current user's pod and its members
router.get('/:roomId/pod', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth.userId;

    const { data: member } = await supabase
      .from('watch_mate_members')
      .select('pod_id, match_reason')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (!member) {
      return res.status(404).json({ error: 'You are not in a Watch Mate pod for this room' });
    }

    const { data: members } = await supabase
      .from('watch_mate_members')
      .select(`
        user_id,
        is_admin,
        joined_at,
        users (id, display_name, avatar_url)
      `)
      .eq('pod_id', member.pod_id)
      .eq('is_active', true);

    const shaped = (members || []).map((m) => ({
      user_id: m.user_id,
      display_name: m.users?.display_name || 'User',
      avatar_url: m.users?.avatar_url || null,
      is_admin: m.is_admin,
      joined_at: m.joined_at,
    }));

    const reason = member.match_reason || 'matched';
    return res.status(200).json({
      pod_id: member.pod_id,
      member_count: shaped.length,
      match_reason: reason,
      banner: BANNERS[reason] || BANNERS.matched,
      members: shaped,
    });
  } catch (err) {
    console.error('Watch Mate pod fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Watch Mate pod' });
  }
});

// POST /api/watchmate/:roomId/move — Admin Move button (relocates member to another pod + audit log)
router.post('/:roomId/move', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const actorId = req.auth.userId;
    const { target_user_id, target_pod_id } = req.body || {};

    if (!target_user_id) {
      return res.status(400).json({ error: 'target_user_id is required' });
    }

    // Verify actor is either the room host or pod admin
    const [{ data: room }, { data: actorMember }] = await Promise.all([
      supabase.from('rooms').select('host_id').eq('id', roomId).maybeSingle(),
      supabase
        .from('watch_mate_members')
        .select('pod_id, is_admin')
        .eq('room_id', roomId)
        .eq('user_id', actorId)
        .eq('is_active', true)
        .maybeSingle(),
    ]);

    const isAdmin = room?.host_id === actorId || Boolean(actorMember?.is_admin);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only an admin can move viewers between groups' });
    }

    const { data: targetMember } = await supabase
      .from('watch_mate_members')
      .select('pod_id')
      .eq('room_id', roomId)
      .eq('user_id', target_user_id)
      .eq('is_active', true)
      .maybeSingle();

    if (!targetMember) {
      return res.status(404).json({ error: 'Target user is not in a Watch Mate pod in this room' });
    }

    const oldPodId = targetMember.pod_id;
    let newPodId = target_pod_id;

    if (!newPodId) {
      const { data: altPods } = await supabase
        .from('watch_mate_pods')
        .select('id, member_count')
        .eq('room_id', roomId)
        .neq('id', oldPodId)
        .lt('member_count', 12)
        .limit(1);

      if (altPods && altPods.length > 0) {
        newPodId = altPods[0].id;
      } else {
        const { data: createdPod } = await supabase
          .from('watch_mate_pods')
          .insert({ room_id: roomId, capacity: 12, member_count: 0 })
          .select()
          .single();
        newPodId = createdPod.id;
      }
    }

    // Deactivate in old pod and add to new pod
    await supabase
      .from('watch_mate_members')
      .update({ is_active: false, is_admin: false })
      .eq('pod_id', oldPodId)
      .eq('user_id', target_user_id);

    await supabase.from('watch_mate_members').upsert(
      {
        pod_id: newPodId,
        user_id: target_user_id,
        room_id: roomId,
        is_active: true,
        is_admin: false,
        match_reason: 'moved_by_admin',
      },
      { onConflict: 'pod_id,user_id' }
    );

    const [{ count: oldCount }, { count: newCount }] = await Promise.all([
      supabase.from('watch_mate_members').select('*', { count: 'exact', head: true }).eq('pod_id', oldPodId).eq('is_active', true),
      supabase.from('watch_mate_members').select('*', { count: 'exact', head: true }).eq('pod_id', newPodId).eq('is_active', true),
    ]);

    await Promise.all([
      supabase.from('watch_mate_pods').update({ member_count: oldCount || 0 }).eq('id', oldPodId),
      supabase.from('watch_mate_pods').update({ member_count: newCount || 1 }).eq('id', newPodId),
      supabase.from('moderation_logs').insert({
        room_id: roomId,
        actor_id: actorId,
        target_user_id,
        action: 'watchmate_move',
        details: { from_pod_id: oldPodId, to_pod_id: newPodId },
      }),
    ]);

    return res.status(200).json({
      message: 'Viewer moved to new Watch Mate group',
      from_pod_id: oldPodId,
      to_pod_id: newPodId,
    });
  } catch (err) {
    console.error('Watch Mate move error:', err.message);
    return res.status(500).json({ error: 'Failed to move viewer' });
  }
});

// POST /api/watchmate/:roomId/leave — leave watch mate pod
router.post('/:roomId/leave', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth.userId;

    const { data: member } = await supabase
      .from('watch_mate_members')
      .select('pod_id, is_admin')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (!member) {
      return res.status(404).json({ error: 'You are not in a Watch Mate pod' });
    }

    await supabase
      .from('watch_mate_members')
      .update({ is_active: false })
      .eq('pod_id', member.pod_id)
      .eq('user_id', userId);

    const { count } = await supabase
      .from('watch_mate_members')
      .select('*', { count: 'exact', head: true })
      .eq('pod_id', member.pod_id)
      .eq('is_active', true);

    await supabase
      .from('watch_mate_pods')
      .update({ member_count: count || 0 })
      .eq('id', member.pod_id);

    if (member.is_admin && count > 0) {
      const { data: nextMember } = await supabase
        .from('watch_mate_members')
        .select('user_id')
        .eq('pod_id', member.pod_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      if (nextMember) {
        await supabase
          .from('watch_mate_members')
          .update({ is_admin: true })
          .eq('pod_id', member.pod_id)
          .eq('user_id', nextMember.user_id);
      }
    }

    return res.status(200).json({ message: 'Left Watch Mate pod' });
  } catch (err) {
    console.error('Watch Mate leave error:', err.message);
    return res.status(500).json({ error: 'Failed to leave Watch Mate pod' });
  }
});

module.exports = router;
