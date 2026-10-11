TEST 'VAR_TEMP starts from its initial value at every call'
  VAR uut : TempCounter; END_VAR
  uut();
  ASSERT_EQ(uut.total, 8);
  uut();
  ASSERT_EQ(uut.total, 16);
  uut();
  ASSERT_EQ(uut.total, 24);
END_TEST
