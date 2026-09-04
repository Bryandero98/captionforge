import threading

import pytest

from captionforge.jobs import (
    InvalidTransitionError,
    JobConflictError,
    JobStatus,
    JobStore,
    UnknownJobError,
)


class TestJobStoreCreate:
    def test_create_returns_a_fresh_queued_job(self):
        store = JobStore()
        job = store.create()
        assert job.status == JobStatus.QUEUED
        assert job.progress == 0.0
        assert job.srt_ready is False
        assert job.video_ready is False

    def test_create_rejects_a_second_job_while_one_is_active(self):
        store = JobStore()
        store.create()
        with pytest.raises(JobConflictError):
            store.create()

    def test_create_allows_a_new_job_once_the_previous_one_finished(self):
        store = JobStore()
        first = store.create()
        store.transition(first.id, JobStatus.EXTRACTING_AUDIO)
        store.transition(first.id, JobStatus.TRANSCRIBING)
        store.transition(first.id, JobStatus.DONE)

        second = store.create()
        assert second.id != first.id

    def test_create_allows_a_new_job_after_the_previous_one_errored(self):
        store = JobStore()
        first = store.create()
        store.transition(first.id, JobStatus.ERROR)

        second = store.create()
        assert second.id != first.id


class TestJobStoreTransitions:
    def test_valid_forward_path_transcribe_only(self):
        store = JobStore()
        job = store.create()
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        store.transition(job.id, JobStatus.TRANSCRIBING)
        result = store.transition(job.id, JobStatus.DONE)
        assert result.status == JobStatus.DONE

    def test_valid_forward_path_including_burn(self):
        store = JobStore()
        job = store.create()
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        store.transition(job.id, JobStatus.TRANSCRIBING)
        store.transition(job.id, JobStatus.DONE)
        store.transition(job.id, JobStatus.BURNING_SUBTITLES)
        result = store.transition(job.id, JobStatus.BURNED)
        assert result.status == JobStatus.BURNED

    def test_skipping_a_stage_is_rejected(self):
        store = JobStore()
        job = store.create()
        with pytest.raises(InvalidTransitionError):
            store.transition(job.id, JobStatus.TRANSCRIBING)

    def test_a_not_yet_cached_model_can_route_through_downloading_model(self):
        store = JobStore()
        job = store.create()
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        store.transition(job.id, JobStatus.DOWNLOADING_MODEL)
        result = store.transition(job.id, JobStatus.TRANSCRIBING)
        assert result.status == JobStatus.TRANSCRIBING

    def test_a_cached_model_can_skip_downloading_model_entirely(self):
        # EXTRACTING_AUDIO -> TRANSCRIBING directly must keep working - most
        # jobs reuse an already-cached model and never touch the new status.
        store = JobStore()
        job = store.create()
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        result = store.transition(job.id, JobStatus.TRANSCRIBING)
        assert result.status == JobStatus.TRANSCRIBING

    def test_downloading_model_is_unreachable_directly_from_queued(self):
        store = JobStore()
        job = store.create()
        with pytest.raises(InvalidTransitionError):
            store.transition(job.id, JobStatus.DOWNLOADING_MODEL)

    def test_transitioning_a_terminal_status_forward_is_rejected(self):
        store = JobStore()
        job = store.create()
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        store.transition(job.id, JobStatus.TRANSCRIBING)
        store.transition(job.id, JobStatus.DONE)
        store.transition(job.id, JobStatus.BURNING_SUBTITLES)
        store.transition(job.id, JobStatus.BURNED)
        with pytest.raises(InvalidTransitionError):
            store.transition(job.id, JobStatus.BURNING_SUBTITLES)

    def test_any_status_can_move_to_error(self):
        store = JobStore()
        job = store.create()
        store.transition(job.id, JobStatus.EXTRACTING_AUDIO)
        result = store.transition(job.id, JobStatus.ERROR)
        assert result.status == JobStatus.ERROR

    def test_unknown_job_id_raises(self):
        store = JobStore()
        store.create()
        with pytest.raises(UnknownJobError):
            store.transition("not-a-real-id", JobStatus.EXTRACTING_AUDIO)


class TestJobStoreUpdateAndGet:
    def test_update_sets_arbitrary_fields_without_changing_status(self):
        store = JobStore()
        job = store.create()
        updated = store.update(job.id, progress=0.5, stage_label="Transcribiendo (50%)")
        assert updated.progress == 0.5
        assert updated.stage_label == "Transcribiendo (50%)"
        assert updated.status == JobStatus.QUEUED

    def test_get_returns_the_current_job_state(self):
        store = JobStore()
        job = store.create()
        store.update(job.id, progress=0.3)
        assert store.get(job.id).progress == 0.3

    def test_get_unknown_job_id_raises(self):
        store = JobStore()
        with pytest.raises(UnknownJobError):
            store.get("nope")


class TestJobStoreThreadSafety:
    def test_concurrent_create_attempts_only_one_wins(self):
        # Fires many threads at create() simultaneously - the lock must
        # ensure exactly one succeeds and every other one sees the conflict,
        # not a race where two both think they created the active job.
        store = JobStore()
        successes = []
        conflicts = []
        lock = threading.Lock()

        def attempt():
            try:
                job = store.create()
                with lock:
                    successes.append(job)
            except JobConflictError:
                with lock:
                    conflicts.append(True)

        threads = [threading.Thread(target=attempt) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(successes) == 1
        assert len(conflicts) == 19
