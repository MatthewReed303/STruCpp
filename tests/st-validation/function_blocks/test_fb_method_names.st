TEST 'methods of a block, inherited and through interfaces'
  VAR f : F; g : G; m : I_A; END_VAR
  f();
  ASSERT_TRUE(f.IsGood);
  ASSERT_EQ(f.TotalOut, 1.0);
  ASSERT_EQ(f.OwnOut, 7);
  g();
  ASSERT_EQ(g.Sum, 2.0);
  m := g;
  ASSERT_TRUE(m.Good());
END_TEST
