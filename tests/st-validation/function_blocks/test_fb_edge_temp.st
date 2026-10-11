TEST 'rising edge once per transition, held TRUE at first call is an edge'
  VAR e : EdgeFB; END_VAR
  e(Start := TRUE, Stop := TRUE);
  ASSERT_EQ(e.starts, 1);
  e(Start := TRUE);
  ASSERT_EQ(e.starts, 1);
  ASSERT_FALSE(e.sawStart);
  e();
  e();
  ASSERT_EQ(e.starts, 1);
  e(Start := FALSE);
  e(Start := TRUE);
  ASSERT_EQ(e.starts, 2);
  ASSERT_TRUE(e.sawStart);
  ASSERT_TRUE(e.Start);
END_TEST
TEST 'falling edge, input FALSE at first call is an edge (Table 44 note)'
  VAR e : EdgeFB; END_VAR
  e(Stop := FALSE);
  ASSERT_EQ(e.stops, 1);
  e(Stop := FALSE);
  ASSERT_EQ(e.stops, 1);
  e(Stop := TRUE);
  ASSERT_EQ(e.stops, 1);
  e(Stop := FALSE);
  ASSERT_EQ(e.stops, 2);
END_TEST
