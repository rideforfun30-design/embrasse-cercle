import { test } from "node:test";
import assert from "node:assert/strict";
import { cancellationEffectiveAt, membershipIsActive, monthlyPeriodStart } from "../lib/membership-policy";

test("one calendar month notice rounds to Paris billing boundaries across year and DST changes",()=>{
 const cases=[
  ["2026-10-27T10:00:00.000Z","2026-11-30T23:00:00.000Z"],
  ["2026-12-31T10:00:00.000Z","2027-01-31T23:00:00.000Z"],
  ["2026-01-31T10:00:00.000Z","2026-02-28T23:00:00.000Z"],
  ["2028-01-31T10:00:00.000Z","2028-02-29T23:00:00.000Z"],
  ["2026-02-28T10:00:00.000Z","2026-03-31T22:00:00.000Z"],
  ["2026-03-31T10:00:00.000Z","2026-04-30T22:00:00.000Z"],
  ["2026-07-31T10:00:00.000Z","2026-08-31T22:00:00.000Z"],
  ["2026-09-30T10:00:00.000Z","2026-10-31T23:00:00.000Z"],
  ["2026-10-31T23:00:00.000Z","2026-11-30T23:00:00.000Z"],
  ["2026-10-31T23:00:00.001Z","2026-12-31T23:00:00.000Z"],
 ];
 for(const [at,expected] of cases)assert.equal(cancellationEffectiveAt(at),expected,at);
 assert.throws(()=>cancellationEffectiveAt("bad"));
});

test("scheduled membership stays active until the exact effective instant",()=>{
 const end="2026-11-30T23:00:00.000Z";
 assert.equal(membershipIsActive("active",end,"2026-11-30T22:59:59.999Z"),true);
 assert.equal(membershipIsActive("active",end,end),false);
 assert.equal(membershipIsActive("active",null,end),true);
 assert.equal(membershipIsActive("pending",null,end),false);
});

test("monthly period cutoff is Paris midnight, including DST",()=>{
 assert.equal(monthlyPeriodStart("2026-12"),"2026-11-30T23:00:00.000Z");
 assert.equal(monthlyPeriodStart("2026-08"),"2026-07-31T22:00:00.000Z");
 for(const invalid of ["2026-13","2026-00","2026-1","junk","2019-12"])assert.throws(()=>monthlyPeriodStart(invalid));
});
