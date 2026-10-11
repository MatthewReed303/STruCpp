TEST 'super body once'
  VAR d : Derived1; END_VAR
  d(a := 123, b := 1);
  ASSERT_EQ(d.x, 373);

END_TEST
TEST 'chain'
  VAR d : Derived2; v : INT; END_VAR
  d(a := 1, b := 2, c := v);
  ASSERT_EQ(d.x, 8);
  ASSERT_EQ(v, 8);
END_TEST
TEST 'override and interface'
  VAR d1 : Derived1; d2 : Derived2; END_VAR
  ASSERT_EQ(KindOf(k := d1), 11);
  ASSERT_EQ(KindOf(k := d2), 20);
END_TEST
TEST 'dynamic body binding through in-out of base type'
  VAR d3 : Derived3; r : Runner; END_VAR
  r(inst := d3);
  ASSERT_EQ(d3.x, 1008);
END_TEST

TEST 'IEC example: LIGHT2ROOM with SUPER, THIS passed to an interface input'
  VAR r : LIGHT2ROOM; c : ROOM_CTRL; END_VAR
  c(RM := r, Night := TRUE);
  ASSERT_TRUE(r.LIGHT);
  ASSERT_FALSE(r.LIGHT2);
  c(RM := r, Night := FALSE);
  ASSERT_FALSE(r.LIGHT);
  ASSERT_TRUE(r.LIGHT2);
  r(Night := TRUE);
  ASSERT_TRUE(r.LIGHT);
  ASSERT_FALSE(r.LIGHT2);
END_TEST
TEST 'abstract method implemented in derived, base body via SUPER'
  VAR s : SQUARE; END_VAR
  s(side := 3.0);
  ASSERT_EQ(s.area, 9.0);
END_TEST
