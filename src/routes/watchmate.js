const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// Core matching function
const assignUserToPod = async (roomId, userId) => {
  // Step 1 — Get who the user follows
  const { data: followingData } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId);

  const followingIds = followingData?.map(f => f.following_id) || [];

  // Step 2 — Get user's categories
  const { data: userCategories } = await supabase
    .from('user_categories')
    .select('category')
    .eq('user_id', userId);

  const categories = userCategories?.map(c => c.category) || [];

  // Step 3 — Get all active pods in this room that aren't full
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

  if (pods && pods.length > 0) {
    // Step 4 — Try to find a pod containing someone the user follows
    let bestPod = null;
    let bestScore = 0;

    for (const pod of pods) {
      const memberIds = pod.watch_mate_members.map(m => m.user_id);
      const followsInPod = memberIds.filter(id => followingIds.includes(id));

      if (followsInPod.length > bestScore) {
        bestScore = followsInPod.length;
        bestPod = pod;
      }
    }

    if (bestPod) {
      // Place in pod with most followed people
      assignedPodId = bestPod.id;
    } else {
      // Step 5 — No followed people found, pick first available pod
      assignedPodId = pods[0].id;
    }
  }

  // Step 6 — No available pod exists, create a new one
  if (!assignedPodId) {
    const { data: newPod } = await supabase
      .from('watch_mate_pods')
      .insert({ room_id: roomId, capacity: 12, member_count: 0 })
      .select()
      .single();

    assignedPodId = newPod.id;
  }

  // Step 7 — Add user to the pod
  await supabase
    .from('watch_mate_members')
    .upsert({
      pod_id: assignedPodId,
      user_id: userId,
      room_id: roomId,
      is_active: true,
      is_admin: false,
    }, { onConflict: 'pod_id,user_id' });

  // Step 8 — Check if this user should be pod admin (first member)
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

  // Step 9 — Update pod member count
  const { count: updatedCount } = await supabase
    .from('watch_mate_members')
    .select('*', { count: 'exact', head: true })
    .eq('pod_id', assignedPodId)
    .eq('is_active', true);

  await supabase
    .from('watch_mate_pods')
    .update({ member_count: updatedCount })
    .eq('id', assignedPodId);

  return assignedPodId;
};

// POST /api/watchmate/:roomId/join — assign user to a watch mate pod
router.post('/:roomId/join', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth.userId;

    // Check if user is already in a pod for this room
    const { data: existing } = await supabase
      .from('watch_mate_members')
      .select('pod_id')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (existing) {
      return res.status(200).json({
        message: 'Already in a Watch Mate pod',
        pod_id: existing.pod_id,
      });
    }

    const podId = await assignUserToPod(roomId, userId);

    return res.status(200).json({
      message: 'Assigned to Watch Mate pod',
      pod_id: podId,
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

    // Find user's pod
    const { data: member } = await supabase
      .from('watch_mate_members')
      .select('pod_id')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (!member) {
      return res.status(404).json({ error: 'You are not in a Watch Mate pod for this room' });
    }

    // Get all members in the pod
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

    const shaped = (members || []).map(m => ({
      user_id: m.user_id,
      display_name: m.users?.display_name || 'User',
      avatar_url: m.users?.avatar_url || null,
      is_admin: m.is_admin,
      joined_at: m.joined_at,
    }));

    return res.status(200).json({
      pod_id: member.pod_id,
      member_count: shaped.length,
      members: shaped,
    });

  } catch (err) {
    console.error('Watch Mate pod fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Watch Mate pod' });
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
      .single();

    if (!member) {
      return res.status(404).json({ error: 'You are not in a Watch Mate pod' });
    }

    // Mark as inactive
    await supabase
      .from('watch_mate_members')
      .update({ is_active: false })
      .eq('pod_id', member.pod_id)
      .eq('user_id', userId);

    // Update pod member count
    const { count } = await supabase
      .from('watch_mate_members')
      .select('*', { count: 'exact', head: true })
      .eq('pod_id', member.pod_id)
      .eq('is_active', true);

    await supabase
      .from('watch_mate_pods')
      .update({ member_count: count || 0 })
      .eq('id', member.pod_id);

    // If user was admin, promote next member
    if (member.is_admin && count > 0) {
      const { data: nextMember } = await supabase
        .from('watch_mate_members')
        .select('user_id')
        .eq('pod_id', member.pod_id)
        .eq('is_active', true)
        .limit(1)
        .single();

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
