TEST 'derived body reads and writes the base in-out, both in-outs bound'
  VAR d : IoDerived; data : IO_DATA; extra : IO_EXTRA; END_VAR
  extra.z := 3;
  d(Data := data, Extra := extra);
  ASSERT_EQ(data.set.x, 3);
  ASSERT_TRUE(data.sts.y);
  ASSERT_EQ(data.sts.n, 1);
  ASSERT_EQ(d.q, 3);
  ASSERT_EQ(extra.z, 13);
  data.simulate := TRUE;
  d(Data := data, Extra := extra);
  ASSERT_EQ(data.set.x, 13);
  ASSERT_EQ(data.sts.n, 2);
  ASSERT_EQ(extra.z, 13);
END_TEST
