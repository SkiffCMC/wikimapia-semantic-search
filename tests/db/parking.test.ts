/**
 * AL2 unit tests: the pure Parking decision `parkedPlacesFrom(rows)` of `src/db/parking.ts`
 * (AL4 crawl-run1-fixes 1.3 `parking.ts` signatures, 1.4.6 "Deciding Parking", 2.5
 * `ParkingRowSchema`). AL3 routing 20261022-crawl-run1-fixes-04-parking, section 2.1 A.
 *
 * No database. `ParkingRow`s are built by hand in the shape of the AL4 1.4.6 statement: one row
 * per Failure Record about a Place, each carrying that Place's `details_fetched_at_text` and
 * latest `released_at_text`. The expected Parked Places are always computed with the contract's
 * own `countResetOf` + `parkingKindOf` / `isParkedPlace` (the rule is never copied here), so the
 * function must agree with the contract on every case of the "Parking rules (pure)" describe of
 * `contracts/crawl-run1-fixes.schema.test.ts` (AC-29 .. AC-33, AC-38). All data is synthetic.
 */
import { parkedPlacesFrom } from '../../src/db/parking';
import type { ParkedPlace, ParkingRow } from '../../src/db/types';
import {
  countResetOf,
  isParkedPlace,
  parkingKindOf,
  type FailureRecord,
} from '../../contracts/crawl-run1-fixes.schema';
import type { ItemFailureKind, Moment } from '../../contracts/hydration.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same hour moments as the contract test (`H(9)` = 09:00:00Z on 2026-10-22). */
const H = (hour: number): Moment => `2026-10-22T${String(hour).padStart(2, '0')}:00:00Z`;

interface RowOptions {
  runId?: number;
  detailsAt?: Moment | null;
  releasedAt?: Moment | null;
}

/** One `ParkingRow` (snake_case, as `ParkingRowSchema` reads it). */
function row(
  placeId: number,
  failureKind: ItemFailureKind,
  failedAt: Moment,
  options: RowOptions = {},
): ParkingRow {
  return {
    run_id: options.runId ?? 1,
    place_id: placeId,
    failure_kind: failureKind,
    message: `Place ${String(placeId)}: synthetic ${failureKind}`,
    failed_at_text: failedAt,
    details_fetched_at_text: options.detailsAt ?? null,
    released_at_text: options.releasedAt ?? null,
  };
}

/** Rows of one Place that share its Count Reset inputs (as the SQL repeats them per row). */
function rowsOf(
  placeId: number,
  failures: readonly [ItemFailureKind, Moment][],
  options: RowOptions = {},
): ParkingRow[] {
  return failures.map(([kind, failedAt], i) =>
    row(placeId, kind, failedAt, { ...options, runId: options.runId ?? i + 1 }),
  );
}

function recordOf(r: ParkingRow): FailureRecord {
  return {
    runId: r.run_id,
    item: { kind: 'place_details', placeId: r.place_id },
    failureKind: r.failure_kind,
    message: r.message,
    failedAt: r.failed_at_text,
  };
}

/** Count Reset of a Place from its rows, through the contract (`undefined` keys left out). */
function resetOf(rows: readonly ParkingRow[]): Moment | undefined {
  const first = rows[0];
  if (first === undefined) return undefined;
  return countResetOf({
    ...(first.details_fetched_at_text === null
      ? {}
      : { lastDetailsSaveAt: first.details_fetched_at_text }),
    ...(first.released_at_text === null ? {} : { lastExplicitRetryAt: first.released_at_text }),
  });
}

/** The Parked Places the contract derives from `rows`, ascending Place ID. */
function contractParked(rows: readonly ParkingRow[]): ParkedPlace[] {
  const placeIds = [...new Set(rows.map((r) => r.place_id))].sort((a, b) => a - b);
  const parked: ParkedPlace[] = [];
  for (const placeId of placeIds) {
    const own = rows.filter((r) => r.place_id === placeId);
    const kind = parkingKindOf(own.map(recordOf), placeId, resetOf(own));
    if (kind !== undefined) parked.push({ placeId, failureKind: kind });
  }
  return parked;
}

/** Whether the contract parks `placeId` given its rows. */
function contractIsParked(rows: readonly ParkingRow[], placeId: number): boolean {
  const own = rows.filter((r) => r.place_id === placeId);
  return isParkedPlace(own.map(recordOf), placeId, resetOf(own));
}

/** `parkedPlacesFrom(rows)` equals the contract's answer exactly. */
function expectAgreement(rows: readonly ParkingRow[]): ParkedPlace[] {
  const actual = parkedPlacesFrom(rows);
  expect(actual).toStrictEqual(contractParked(rows));
  return actual;
}

// ===========================================================================
// A.1 Agreement with the contract's "Parking rules (pure)" cases
// ===========================================================================

describe('A.1 parkedPlacesFrom agrees with the contract', () => {
  it('AC-29: two Wikimapia Errors do not park; the third parks 900 with wikimapia_error', () => {
    const two = rowsOf(900, [
      ['wikimapia_error', H(9)],
      ['wikimapia_error', H(10)],
    ]);
    expect(contractIsParked(two, 900)).toBe(false);
    expect(expectAgreement(two)).toStrictEqual([]);

    const three = [...two, row(900, 'wikimapia_error', H(11), { runId: 3 })];
    expect(contractIsParked(three, 900)).toBe(true);
    expect(expectAgreement(three)).toStrictEqual([
      { placeId: 900, failureKind: parkingKindOf(three.map(recordOf), 900) },
    ]);
  });

  it('AC-30: records of every Run count', () => {
    const rows = [1, 2, 3].map((runId) => row(900, 'unexpected_response', H(8 + runId), { runId }));
    expect(contractIsParked(rows, 900)).toBe(true);
    expect(expectAgreement(rows)).toHaveLength(1);
  });

  it('AC-31: alternating kinds 2 + 2 do not park; a fifth of either kind does, with that kind', () => {
    const alternating = rowsOf(900, [
      ['wikimapia_error', H(9)],
      ['unexpected_response', H(10)],
      ['wikimapia_error', H(11)],
      ['unexpected_response', H(12)],
    ]);
    expect(contractIsParked(alternating, 900)).toBe(false);
    expect(expectAgreement(alternating)).toStrictEqual([]);

    const moreErrors = [...alternating, row(900, 'wikimapia_error', H(13), { runId: 5 })];
    expect(expectAgreement(moreErrors)).toStrictEqual([
      { placeId: 900, failureKind: parkingKindOf(moreErrors.map(recordOf), 900) },
    ]);
    const moreUnexpected = [...alternating, row(900, 'unexpected_response', H(13), { runId: 5 })];
    expect(expectAgreement(moreUnexpected)).toStrictEqual([
      { placeId: 900, failureKind: parkingKindOf(moreUnexpected.map(recordOf), 900) },
    ]);
    expect(parkedPlacesFrom(moreErrors)[0]?.failureKind).not.toBe(
      parkedPlacesFrom(moreUnexpected)[0]?.failureKind,
    );
  });

  it('AC-32: four Connection Failures never park; three Invalid Data do', () => {
    const connection = [9, 10, 11, 12].map((h, i) => row(900, 'connection', H(h), { runId: i + 1 }));
    expect(contractIsParked(connection, 900)).toBe(false);
    expect(expectAgreement(connection)).toStrictEqual([]);

    const invalid = [9, 10, 11].map((h, i) => row(900, 'invalid_data', H(h), { runId: i + 1 }));
    expect(contractIsParked(invalid, 900)).toBe(true);
    expect(expectAgreement(invalid)).toHaveLength(1);
  });

  it('AC-33 / AC-38: a Details Save, or a later Explicit Retry, resets the count', () => {
    const failures: [ItemFailureKind, Moment][] = [
      ['wikimapia_error', H(9)],
      ['wikimapia_error', H(10)],
      ['wikimapia_error', H(12)],
    ];
    const noReset = rowsOf(900, failures);
    expect(contractIsParked(noReset, 900)).toBe(true);
    expect(expectAgreement(noReset)).toHaveLength(1);

    const afterSave = rowsOf(900, failures, { detailsAt: H(11) });
    expect(contractIsParked(afterSave, 900)).toBe(false);
    expect(expectAgreement(afterSave)).toStrictEqual([]);

    const afterSaveAndRetry = rowsOf(900, failures, { detailsAt: H(11), releasedAt: H(13) });
    expect(contractIsParked(afterSaveAndRetry, 900)).toBe(false);
    expect(expectAgreement(afterSaveAndRetry)).toStrictEqual([]);
  });

  it('AC-38: a failure in the same second as the Explicit Retry counts; one second later it does not', () => {
    const failures: [ItemFailureKind, Moment][] = [
      ['wikimapia_error', H(15)],
      ['wikimapia_error', H(16)],
      ['wikimapia_error', H(17)],
    ];
    const sameSecond = rowsOf(900, failures, { releasedAt: H(15) });
    expect(contractIsParked(sameSecond, 900)).toBe(true);
    expect(expectAgreement(sameSecond)).toHaveLength(1);

    const oneLater = rowsOf(900, failures, { releasedAt: '2026-10-22T15:00:01Z' });
    expect(contractIsParked(oneLater, 900)).toBe(false);
    expect(expectAgreement(oneLater)).toStrictEqual([]);
  });
});

// ===========================================================================
// A.2 Reset sources
// ===========================================================================

describe('A.2 the Count Reset comes from the Details Save and the latest release', () => {
  const FOUR: [ItemFailureKind, Moment][] = [
    ['wikimapia_error', H(9)],
    ['wikimapia_error', H(10)],
    ['wikimapia_error', H(11)],
    ['wikimapia_error', H(12)],
  ];

  it('details_fetched_at_text alone: records strictly before it do not count', () => {
    // Reset at 10:00:00 leaves 10, 11, 12 (3 counted): Parked.
    const atTen = rowsOf(900, FOUR, { detailsAt: H(10) });
    expect(contractIsParked(atTen, 900)).toBe(true);
    expect(expectAgreement(atTen)).toHaveLength(1);
    // Reset at 10:00:01 leaves 11, 12 (2 counted): not Parked.
    const afterTen = rowsOf(900, FOUR, { detailsAt: '2026-10-22T10:00:01Z' });
    expect(contractIsParked(afterTen, 900)).toBe(false);
    expect(expectAgreement(afterTen)).toStrictEqual([]);
  });

  it('released_at_text alone: records strictly before it do not count, the same second counts', () => {
    const atTen = rowsOf(900, FOUR, { releasedAt: H(10) });
    expect(contractIsParked(atTen, 900)).toBe(true);
    expect(expectAgreement(atTen)).toHaveLength(1);
    const afterTen = rowsOf(900, FOUR, { releasedAt: '2026-10-22T10:00:01Z' });
    expect(contractIsParked(afterTen, 900)).toBe(false);
    expect(expectAgreement(afterTen)).toStrictEqual([]);
  });

  it('both set, the release later: the release is the reset', () => {
    // Details 09:00 alone would count all 4; release 10:00:01 leaves 2.
    const rows = rowsOf(900, FOUR, { detailsAt: H(9), releasedAt: '2026-10-22T10:00:01Z' });
    expect(contractIsParked(rows, 900)).toBe(false);
    expect(expectAgreement(rows)).toStrictEqual([]);
    expect(expectAgreement(rowsOf(900, FOUR, { detailsAt: H(9) }))).toHaveLength(1);
  });

  it('both set, the Details Save later: the Details Save is the reset', () => {
    // Release 09:00 alone would count all 4; Details Save 10:00:01 leaves 2.
    const rows = rowsOf(900, FOUR, { detailsAt: '2026-10-22T10:00:01Z', releasedAt: H(9) });
    expect(contractIsParked(rows, 900)).toBe(false);
    expect(expectAgreement(rows)).toStrictEqual([]);
    expect(expectAgreement(rowsOf(900, FOUR, { releasedAt: H(9) }))).toHaveLength(1);
  });

  it('both set and equal: records from that second on count', () => {
    const rows = rowsOf(900, FOUR, { detailsAt: H(10), releasedAt: H(10) });
    expect(contractIsParked(rows, 900)).toBe(true);
    expect(expectAgreement(rows)).toHaveLength(1);
  });
});

// ===========================================================================
// A.3 Several Places in one row list
// ===========================================================================

describe('A.3 several Places', () => {
  it('the result is ascending by placeId and each Place is judged on its own rows only', () => {
    const rows: ParkingRow[] = [
      // 300: three invalid_data, Parked.
      ...rowsOf(300, [
        ['invalid_data', H(9)],
        ['invalid_data', H(10)],
        ['invalid_data', H(11)],
      ]),
      // 700: two errors only, not Parked (it must not borrow 900's errors).
      ...rowsOf(700, [
        ['wikimapia_error', H(9)],
        ['wikimapia_error', H(10)],
      ]),
      // 900: three errors, Parked.
      ...rowsOf(900, [
        ['wikimapia_error', H(9)],
        ['wikimapia_error', H(10)],
        ['wikimapia_error', H(11)],
      ]),
      // 950: three errors, but its own release resets them, not Parked.
      ...rowsOf(
        950,
        [
          ['wikimapia_error', H(9)],
          ['wikimapia_error', H(10)],
          ['wikimapia_error', H(11)],
        ],
        { releasedAt: H(12) },
      ),
    ];
    const actual = expectAgreement(rows);
    expect(actual.map((p) => p.placeId)).toStrictEqual([300, 900]);
    expect(actual.map((p) => p.failureKind)).toStrictEqual(
      [300, 900].map((id) =>
        parkingKindOf(
          rows.filter((r) => r.place_id === id).map(recordOf),
          id,
        ),
      ),
    );
  });

  it('rows given in descending Place order still give an ascending result', () => {
    const rows: ParkingRow[] = [901, 900, 42].flatMap((placeId) =>
      rowsOf(placeId, [
        ['unexpected_response', H(9)],
        ['unexpected_response', H(10)],
        ['unexpected_response', H(11)],
      ]),
    );
    expect(expectAgreement(rows).map((p) => p.placeId)).toStrictEqual([42, 900, 901]);
  });

  it("one Place's release does not reset another Place", () => {
    const rows: ParkingRow[] = [
      ...rowsOf(
        900,
        [
          ['wikimapia_error', H(9)],
          ['wikimapia_error', H(10)],
          ['wikimapia_error', H(11)],
        ],
        { releasedAt: H(12) },
      ),
      ...rowsOf(901, [
        ['wikimapia_error', H(9)],
        ['wikimapia_error', H(10)],
        ['wikimapia_error', H(11)],
      ]),
    ];
    expect(expectAgreement(rows).map((p) => p.placeId)).toStrictEqual([901]);
  });
});

// ===========================================================================
// A.4 Nothing to park
// ===========================================================================

describe('A.4 nothing Parked', () => {
  it('rows of only connection records give no Parked Place', () => {
    const rows = [900, 901].flatMap((placeId) =>
      [9, 10, 11, 12, 13].map((h, i) => row(placeId, 'connection', H(h), { runId: i + 1 })),
    );
    expect(parkedPlacesFrom(rows)).toStrictEqual([]);
    expect(contractParked(rows)).toStrictEqual([]);
  });

  it('an empty list gives []', () => {
    expect(parkedPlacesFrom([])).toStrictEqual([]);
  });
});
